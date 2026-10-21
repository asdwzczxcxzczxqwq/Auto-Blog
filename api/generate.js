// 타임아웃에 강한 Vercel Edge 런타임 사용
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' }), { status: 500 });
  }

  const { mode, category, input1, input2, input3, rawData, images } = await req.json();

  const categoryNames = {
    case: '납품 및 현장 구축 성공 사례 (1: 타겟 업종/적용 공정, 2: 현장 이슈/기존 한계점, 3: 적용 솔루션 및 개선 효과)',
    tech: '핵심 장비 및 기술 솔루션 상세 소개 (1: 소개할 장비/솔루션명, 2: 핵심 기술 원리 및 스펙, 3: 현장 도입 시 기대 효과)',
    trouble: '제조 공정 트러블슈팅 및 엔지니어링 노하우 (1: 발생한 공정 문제/불량 현상, 2: 원인 분석, 3: 해결 메커니즘 및 재발 방지책)'
  };

  // ==========================================================
  // 모드 1: [🪄 AI 자동 추천] (단문 JSON이므로 즉시 반환)
  // ==========================================================
  if (mode === 'recommend') {
    const recommendPrompt = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
주력 분야: 레이저 마킹/가공(UV/화이버/CO2), 머신비전 검사 및 정밀 얼라인(Align), 열전사 프린터(TTO), PLC/PC 제어 및 라인 모니터링 시스템.
선택 카테고리: [${categoryNames[category] || categoryNames.case}]
힌트: ${input1 || ''} ${rawData || ''}

첨부 자료나 힌트가 있으면 요약해서 3칸을 채우고, 없으면 주력 분야 중 엔지니어가 흥미를 느낄 실전 블로그 주제를 하나 기획해 3칸을 채워주세요. (고객사 실명 익명화 필수)
반드시 아래 JSON 형식으로만 답하세요:
{"input1": "내용1", "input2": "내용2", "input3": "내용3"}
`;

    const parts = [{ text: recommendPrompt }];
    if (images && Array.isArray(images)) {
      images.forEach(img => {
        if (img.mimeType && img.data) parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      });
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] })
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || '추천 실패' }), { status: 500 });
    }
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return new Response(JSON.stringify({ recommendation: parsed }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ==========================================================
  // 모드 2: [✨ 블로그 원고 실시간 스트리밍 생성]
  // ==========================================================
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템.

[작성 규칙]
1. 보안 마스킹: 고객사 실명이나 단가/견적 금액은 '국내 주요 반도체 부품 제조사', 'A사' 등으로 익명화하고 금액은 제외하세요.
2. 네이버 블로그 서식: 마크다운 별표(**) 대신 깔끔한 기호(■, ▶, ✔)와 줄바꿈을 활용하세요.
3. 사진 가이드: 적재적소에 [📸 사진 삽입: ~한 장면] 형태로 가이드를 넣어주세요.

[출력 포맷]
📌 추천 블로그 제목 (3가지)
----------------------------------------
1. 도입부: 현장 페인포인트 공감 및 문제 제기
2. 본문 1: 기존 공정의 한계 및 원인 분석
3. 본문 2: 맞춤형 기술 솔루션 및 시스템 구성 (비전/레이저/제어 특징)
4. 본문 3: 도입 후 개선 효과 (정밀도, 수율, 택트타임, 자동화)
5. 결론: 기술 상담 및 샘플 테스트/맞춤 제작 문의 유도
----------------------------------------
🏷️ 추천 해시태그 (10개 내외)
`;

  const userPrompt = `
[글 카테고리]: ${categoryNames[category] || '기술 블로그'}
[핵심 입력 1]: ${input1 || '(자동 설정)'}
[핵심 입력 2]: ${input2 || '(자동 설정)'}
[핵심 입력 3]: ${input3 || '(자동 설정)'}
[현장 자료 / 추가 메모]: ${rawData || '없음'}
위 정보를 바탕으로 전문 기술 블로그 원고를 작성해 주세요.
`;

  const parts = [{ text: userPrompt }];
  if (images && Array.isArray(images)) {
    images.forEach(img => {
      if (img.mimeType && img.data) parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
    });
  }

  // streamGenerateContent 엔드포인트로 실시간 스트림 요청
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts }]
      })
    }
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return new Response(errText, { status: geminiRes.status });
  }

  // 구글에서 오는 실시간 조각(SSE)을 브라우저로 즉시 토스
  return new Response(geminiRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
