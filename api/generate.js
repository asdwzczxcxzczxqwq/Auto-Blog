export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { category, input1, input2, input3, rawData, images } = req.body || {};

  // [1번 자동화] 회사 정보 및 블로그 작성 고정 규칙
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 역량은 다음과 같습니다:
- 주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템
- 타겟 독자: 제조 기업(반도체, 이차전지, 자동차 부품, 전자/사출 등)의 생산기술팀, 설비엔지니어, 구매 및 자동화 담당자

[필수 작성 및 보안 규칙]
1. 보안 마스킹: 입력된 자료에 특정 고객사 실명이나 단가/견적 금액이 있으면 '국내 주요 반도체 부품 제조사', 'A사' 등으로 익명화하고 금액은 제외하세요.
2. 전문성과 가독성: 기술적 인과관계(원인-해결-결과)를 명확히 서술하되, 네이버 블로그에 바로 붙여넣기 좋게 마크다운 별표(**) 대신 깔끔한 기호(■, ▶, ✔)와 줄바꿈을 활용하세요.
3. 사진 가이드: 첨부된 사진이나 문맥에 맞춰 사진이 들어갈 위치에 [📸 사진 삽입: ~한 장면] 형태로 가이드를 넣어주세요.

[출력 포맷]
📌 추천 블로그 제목 (3가지)
----------------------------------------
1. 도입부: 현장 페인포인트(Pain-Point) 공감 및 문제 제기
2. 본문 1: 기존 공정의 한계 및 원인 분석
3. 본문 2: 맞춤형 기술 솔루션 및 시스템 구성 (비전/레이저/제어 특징)
4. 본문 3: 도입 후 개선 효과 (정밀도, 수율, 택트타임, 자동화)
5. 결론: 기술 상담 및 샘플 테스트/맞춤 제작 문의 유도
----------------------------------------
🏷️ 추천 해시태그 (10개 내외)
`;

  const categoryNames = {
    case: '납품 및 현장 구축 성공 사례',
    tech: '핵심 장비 및 기술 솔루션 상세 소개',
    trouble: '제조 공정 트러블슈팅 및 엔지니어링 노하우'
  };

  const userPrompt = `
[글 카테고리]: ${categoryNames[category] || '기술 블로그'}
[핵심 입력 1]: ${input1 || '없음'}
[핵심 입력 2]: ${input2 || '없음'}
[핵심 입력 3]: ${input3 || '없음'}
[현장 자료 / 추가 사양 텍스트]: ${rawData || '별도 텍스트 자료 없음'}

위 정보를 바탕으로 전문 기술 블로그 포스팅 완성본을 작성해 주세요.
`;

  const parts = [{ text: userPrompt }];
  if (images && Array.isArray(images)) {
    images.forEach(img => {
      if (img.mimeType && img.data) {
        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: img.data
          }
        });
      }
    });
  }

  try {
    // 구글이 지정한 gemini-3.8-flash 호출 + 생각 시간(thinkingBudget) 0으로 설정해 3초 내 초고속 응답
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            thinkingConfig: {
              thinkingBudget: 0
            }
          }
        })
      }
    );

    const data = await response.json();

    // 만약 thinkingConfig 옵션이 호환되지 않는 경우 일반 호출로 즉시 재시도
    if (!response.ok && data.error?.message?.includes('thinking')) {
      const retryRes = await fetch(
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
      const retryData = await retryRes.json();
      if (!retryRes.ok) {
        return res.status(500).json({ error: retryData.error?.message || '호출 실패' });
      }
      const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text || '결과 없음';
      return res.status(200).json({ result: retryText });
    }

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Gemini API 호출 실패' });
    }

    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '결과를 생성하지 못했습니다.';
    return res.status(200).json({ result: resultText });
  } catch (err) {
    return res.status(500).json({ error: '서버 통신 오류: ' + err.message });
  }
}
