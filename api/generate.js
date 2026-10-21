export const config = {
  maxDuration: 60,
};

// 구글 API 호출 헬퍼 함수 (thinkingConfig 호환성 자동 처리 + 20초 타임아웃)
async function callGemini(apiKey, systemInstruction, parts, temperature = 0.7) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // 25초 넘으면 강제 종료

  try {
    // 1차 시도: 초고속 모드 (thinkingBudget: 0)
    let response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...(systemInstruction && { system_instruction: { parts: [{ text: systemInstruction }] } }),
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    let data = await response.json();

    // 만약 thinkingConfig 옵션 에러가 나면 즉시 일반 호출로 재시도 (아까 성공했던 핵심 로직!)
    if (!response.ok && data.error?.message?.toLowerCase().includes('thinking')) {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...(systemInstruction && { system_instruction: { parts: [{ text: systemInstruction }] } }),
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature }
        })
      });
      data = await response.json();
    }

    clearTimeout(timeout);
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('구글 서버 응답이 너무 지연되어 중단되었습니다. 다시 한번 눌러주세요.');
    }
    throw err;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { mode, category, input1, input2, input3, rawData, images } = req.body || {};

  const categoryNames = {
    case: '납품 및 현장 구축 성공 사례 (1: 타겟 업종/적용 공정, 2: 현장 이슈/기존 한계점, 3: 적용 솔루션 및 개선 효과)',
    tech: '핵심 장비 및 기술 솔루션 상세 소개 (1: 소개할 장비/솔루션명, 2: 핵심 기술 원리 및 스펙, 3: 현장 도입 시 기대 효과)',
    trouble: '제조 공정 트러블슈팅 및 엔지니어링 노하우 (1: 발생한 공정 문제/불량 현상, 2: 원인 분석, 3: 해결 메커니즘 및 재발 방지책)'
  };

  // ==========================================================
  // 모드 1: [🪄 AI 자동 추천 / 빈칸 채우기]
  // ==========================================================
  if (mode === 'recommend') {
    const recommendPrompt = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 주력 분야:
1. 레이저 마킹 및 정밀 가공 설비 (UV/화이버/CO2 레이저, 미세 홀가공, 마킹)
2. 머신비전 검사 및 정밀 얼라인(Align) 비전 시스템 (위치 보정, 외관/치수 검사, OCR)
3. 열전사 프린터(TTO) 및 포장/라벨 마킹 자동화
4. PLC / PC 통합 제어 및 스마트팩토리 라인 모니터링 시스템

현재 선택된 카테고리: [${categoryNames[category] || categoryNames.case}]
사용자 힌트/메모: ${input1 || ''} ${rawData || ''}

첨부 자료나 힌트가 있다면 그 내용을 요약해 3칸을 채우고, 아무 자료도 없다면 우리 회사 주력 분야 중 제조 엔지니어가 혹할 만한 실전 블로그 주제를 하나 기획해 3칸을 채워주세요. (고객사 실명은 익명화할 것)

반드시 다른 설명 없이 아래 JSON 형식으로만 응답하세요:
{
  "input1": "첫 번째 칸 내용 (한 줄 요약)",
  "input2": "두 번째 칸 내용 (한 줄 요약)",
  "input3": "세 번째 칸 내용 (한 줄 요약)"
}
`;

    const parts = [{ text: recommendPrompt }];
    if (images && Array.isArray(images)) {
      images.forEach(img => {
        if (img.mimeType && img.data) {
          parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
        }
      });
    }

    try {
      const { ok, data } = await callGemini(apiKey, null, parts, 0.9);
      if (!ok) {
        return res.status(500).json({ error: data.error?.message || '자동 추천 실패' });
      }
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      return res.status(200).json({ recommendation: parsed });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ==========================================================
  // 모드 2: [✨ 블로그 원고 자동 생성하기]
  // ==========================================================
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 역량은 다음과 같습니다:
- 주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템
- 타겟 독자: 제조 기업(반도체, 이차전지, 자동차 부품, 전자/사출, 식품/제약 등)의 생산기술팀, 설비엔지니어, 구매 및 자동화 담당자

[필수 작성 및 보안 규칙]
1. 보안 마스킹: 입력된 자료에 특정 고객사 실명이나 단가/견적 금액이 있으면 '국내 주요 반도체 부품 제조사', 'A사' 등으로 익명화하고 금액은 제외하세요.
2. 전문성과 가독성: 기술적 인과관계(원인-해결-결과)를 명확히 서술하되, 네이버 블로그에 바로 붙여넣기 좋게 마크다운 별표(**) 대신 깔끔한 기호(■, ▶, ✔)와 줄바꿈을 활용하세요.
3. 사진 가이드: 문맥에 맞춰 사진이 들어갈 위치에 [📸 사진 삽입: ~한 장면] 형태로 가이드를 넣어주세요.

[출력 포맷]
📌 추천 블로그 제목 (3가지)
----------------------------------------
1. 도입부: 현장 페인포인트(Pain-Point) 공감 및 문제 제기
2. 본문 1: 기존 공정의 한계 및 원인 분석
3. 본문 2: 맞춤형 기술 솔루션 및 시스템 구성 (비전/레이저/제어 특징 상세화)
4. 본문 3: 도입 후 개선 효과 (정밀도, 수율, 택트타임, 자동화)
5. 결론: 기술 상담 및 샘플 테스트/맞춤 제작 문의 유도
----------------------------------------
🏷️ 추천 해시태그 (10개 내외)
`;

  const userPrompt = `
[글 카테고리]: ${categoryNames[category] || '기술 블로그'}
[핵심 입력 1]: ${input1 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 2]: ${input2 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 3]: ${input3 || '(AI가 문맥에 맞게 자동 설정)'}
[현장 자료 / 추가 사양 텍스트]: ${rawData || '별도 텍스트 자료 없음'}

첨부된 파일과 위 정보를 바탕으로 전문 기술 블로그 포스팅 완성본을 작성해 주세요.
`;

  const parts = [{ text: userPrompt }];
  if (images && Array.isArray(images)) {
    images.forEach(img => {
      if (img.mimeType && img.data) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    });
  }

  try {
    const { ok, data } = await callGemini(apiKey, SYSTEM_INSTRUCTION, parts, 0.7);
    if (!ok) {
      return res.status(500).json({ error: data.error?.message || 'Gemini API 호출 실패' });
    }
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '결과를 생성하지 못했습니다.';
    return res.status(200).json({ result: resultText });
  } catch (err) {
    return res.status(500).json({ error: '서버 통신 오류: ' + err.message });
  }
}
