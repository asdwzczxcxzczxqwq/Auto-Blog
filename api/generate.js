const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // 모드 1: [🪄 AI 자동 추천 / 빈칸 채우기] 요청 처리
  // ==========================================================
  if (mode === 'recommend') {
    const recommendPrompt = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 주력 분야는 다음과 같습니다:
1. 레이저 마킹 및 정밀 가공 설비 (UV/화이버/CO2 레이저, 미세 홀가공, 박리, 마킹)
2. 머신비전 검사 및 정밀 얼라인(Align) 비전 시스템 (위치 보정, 외관/치수 검사, OCR 판독)
3. 열전사 프린터(TTO) 및 포장/라벨 마킹 자동화
4. PLC / PC 통합 제어 및 스마트팩토리 라인 모니터링 시스템 (설비 인터페이스, 실시간 생산/알람 모니터링)

현재 선택된 블로그 카테고리: [${categoryNames[category] || categoryNames.case}]
사용자 힌트/메모: ${input1 || ''} ${rawData || ''}

[지시사항]
- 만약 첨부된 PDF/사진이나 사용자 힌트가 있다면, 그 내용을 분석해서 아래 3가지 항목을 핵심 요약해 채워주세요. (고객사 실명은 반드시 익명화할 것)
- 만약 첨부 자료나 힌트가 전혀 없다면, 위 우리 회사 주력 분야 중 잠재 고객(반도체, 이차전지, 자동차 전장, 제약/식품 포장 등 엔지니어)이 가장 흥미를 느낄 만한 구체적이고 실전적인 블로그 주제를 하나 랜덤으로 기획하여 3가지 항목을 추천해 주세요.

반드시 다른 설명 없이 아래 JSON 형식으로만 응답하세요:
{
  "input1": "첫 번째 칸에 들어갈 내용 (한 줄 요약)",
  "input2": "두 번째 칸에 들어갈 내용 (한 줄 요약)",
  "input3": "세 번째 칸에 들어갈 내용 (한 줄 요약)"
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
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.9,
              thinkingConfig: { thinkingBudget: 0 }
            }
          })
        }
      );

      const data = await response.json();
      if (!response.ok) {
        return res.status(500).json({ error: data.error?.message || '자동 추천 실패' });
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      return res.status(200).json({ recommendation: parsed });
    } catch (err) {
      return res.status(500).json({ error: '추천 생성 오류: ' + err.message });
    }
  }

  // ==========================================================
  // 모드 2: [✨ 블로그 원고 자동 생성하기] 요청 처리
  // ==========================================================
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 역량은 다음과 같습니다:
- 주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템
- 타겟 독자: 제조 기업(반도체, 이차전지, 자동차 부품, 전자/사출, 식품/제약 등)의 생산기술팀, 설비엔지니어, 구매 및 자동화 담당자

[필수 작성 및 보안 규칙]
1. 보안 마스킹: 입력된 자료에 특정 고객사 실명이나 단가/견적 금액이 있으면 '국내 주요 반도체 부품 제조사', 'A사' 등으로 익명화하고 금액은 제외하세요.
2. 전문성과 가독성: 기술적 인과관계(원인-해결-결과)를 명확히 서술하되, 네이버 블로그에 바로 붙여넣기 좋게 마크다운 별표(**) 대신 깔끔한 기호(■, ▶, ✔)와 줄바꿈을 활용하세요.
3. 사진 가이드: 첨부된 사진이나 문맥에 맞춰 사진이 들어갈 위치에 [📸 사진 삽입: ~한 장면] 형태로 가이드를 넣어주세요.
4. 무입력 대응: 만약 사용자가 핵심 입력칸을 비워두었다면, 첨부된 자료를 분석하거나 우리 회사의 주력 기술을 바탕으로 가장 설득력 있는 사례/기술 주제를 스스로 구성하여 완성도 높은 글을 작성하세요.

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

첨부된 파일(이미지 또는 PDF)과 위 정보를 바탕으로, 회사의 기술적 강점이 잘 드러나는 전문 블로그 포스팅 완성본을 작성해 주세요.
`;

  const parts = [{ text: userPrompt }];
  if (images && Array.isArray(images)) {
    images.forEach(img => {
      if (img.mimeType && img.data) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    });
  }

  // 일시적 서버 혼잡(high demand) 시 최대 3회 자동 재시도
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              thinkingConfig: { thinkingBudget: 0 }
            }
          })
        }
      );

      const data = await response.json();

      if (response.ok) {
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '결과를 생성하지 못했습니다.';
        return res.status(200).json({ result: resultText });
      }

      lastError = data.error?.message || 'Gemini API 호출 실패';

      // 서버 과부하 에러인 경우 1.5초 대기 후 자동 재시도
      if (response.status === 503 || response.status === 429 || lastError.includes('demand')) {
        await sleep(1500);
        continue;
      } else {
        break;
      }
    } catch (err) {
      lastError = err.message;
      await sleep(1000);
    }
  }

  return res.status(500).json({ error: lastError });
}
