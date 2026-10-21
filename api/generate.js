export const config = {
  maxDuration: 60,
};

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
    case: '납품 및 현장 구축 성공 사례',
    tech: '핵심 장비 및 기술 솔루션 상세 소개',
    trouble: '제조 공정 트러블슈팅 및 엔지니어링 노하우'
  };

  // 1. AI 자동 추천 모드
  if (mode === 'recommend') {
    const prompt = `
당신은 산업 자동화 및 제조 솔루션 전문 기업의 수석 마케터입니다.
주력 분야: 레이저 마킹/가공, 머신비전 얼라인/검사, 열전사 프린터(TTO), PLC/PC 제어 및 라인 모니터링.
선택 카테고리: [${categoryNames[category] || '납품/구축 사례'}]
힌트: ${input1 || ''} ${rawData || ''}

엔지니어가 흥미를 느낄 만한 블로그 주제를 기획해 아래 3가지 항목을 JSON 형식으로만 답하세요:
{"input1": "타겟 업종 또는 장비명", "input2": "현장 이슈 또는 한계점", "input3": "솔루션 및 개선 효과"}
`;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '추천 실패');
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      return res.status(200).json({ recommendation: match ? JSON.parse(match[0]) : {} });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 2. 블로그 원고 생성 모드
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
- 주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템
- 타겟 독자: 제조 기업(반도체, 이차전지, 자동차 부품, 전자/사출 등)의 생산기술팀, 설비엔지니어, 구매 담당자

[필수 규칙]
1. 보안 마스킹: 고객사 실명이나 단가/견적은 '국내 주요 반도체 부품 제조사', 'A사' 등으로 익명화하세요.
2. 가독성: 마크다운 별표(**) 대신 기호(■, ▶, ✔)와 줄바꿈을 활용하세요.
3. 사진 가이드: [📸 사진 삽입: ~한 장면] 형태로 가이드를 넣어주세요.

[출력 포맷]
📌 추천 블로그 제목 (3가지)
----------------------------------------
1. 도입부: 현장 페인포인트 공감 및 문제 제기
2. 본문 1: 기존 공정의 한계 및 원인 분석
3. 본문 2: 맞춤형 기술 솔루션 및 시스템 구성 (비전/레이저/제어 특징)
4. 본문 3: 도입 후 개선 효과 (정밀도, 수율, 택트타임)
5. 결론: 기술 상담 및 샘플 테스트 문의 유도
----------------------------------------
🏷️ 추천 해시태그 (10개 내외)
`;

  const userPrompt = `
[글 카테고리]: ${categoryNames[category] || '기술 블로그'}
[핵심 입력 1]: ${input1 || '자동 설정'}
[핵심 입력 2]: ${input2 || '자동 설정'}
[핵심 입력 3]: ${input3 || '자동 설정'}
[현장 자료 / 추가 메모]: ${rawData || '없음'}
위 정보를 바탕으로 전문 기술 블로그 원고를 작성해 주세요.
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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts }]
        })
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Gemini API 호출 실패');
    
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '결과를 생성하지 못했습니다.';
    return res.status(200).json({ result: resultText });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
