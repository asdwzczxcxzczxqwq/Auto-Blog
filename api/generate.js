export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { category, input1, input2, input3, rawData, images } = req.body;

  // [1번 자동화] 회사 정보 및 블로그 작성 고정 규칙 (System Instruction)
  const SYSTEM_INSTRUCTION = `
당신은 산업 자동화 설비 및 제조 솔루션 전문 기업의 수석 기술 마케터입니다.
우리 회사의 핵심 역량은 다음과 같습니다:
- 주력 분야: 산업 자동화 시스템, 레이저 마킹/가공 설비, 머신비전 검사 및 정밀 얼라인 시스템, 열전사 프린팅(TTO), PLC/PC 통합 제어 및 라인 모니터링 시스템(MES/인터페이스 연동)
- 타겟 독자: 제조 기업(반도체, 이차전지, 자동차 부품, 전자/사출, 제약/식품 등)의 생산기술팀, 설비엔지니어, 구매 및 공장 자동화 담당자

[필수 작성 및 보안 규칙]
1. 보안 마스킹: 입력된 현장 자료에 특정 고객사 실명(예: OO전자, OO엔지니어링 등)이나 구체적인 단가/견적 금액이 포함되어 있다면, 반드시 '국내 주요 반도체 장비 제조사', '글로벌 자동차 부품 A사' 등으로 익명화 처리하고 금액은 제외하세요.
2. 전문성과 가독성: 엔지니어가 읽었을 때 신뢰감을 느끼도록 기술적 인과관계(원인-제어/광학/기구적 해결-결과)를 명확히 서술하되, 네이버 블로그 등 웹에서 읽기 편하게 마크다운 별표(**) 대신 깔끔한 기호(■, ▶, ✔)와 줄바꿈을 적극 활용하세요.
3. 사진 가이드 반영: 첨부된 사진이 있다면 사진 속 장비/화면의 특징을 분석해 본문 흐름에 맞게 설명하고, 사진이 들어갈 위치에 [📸 사진 삽입: ~한 장면] 형태로 캡션 가이드를 넣어주세요.

[출력 포맷 (반드시 아래 순서를 지킬 것)]
📌 추천 블로그 제목 (검색 유입용 & 클릭 유도용 3가지)
----------------------------------------
1. 도입부: 제조 현장의 페인포인트(Pain-Point) 공감 및 문제 제기
2. 본문 1: 핵심 원인 분석 또는 기존 공정의 한계
3. 본문 2: 맞춤형 기술 솔루션 및 시스템 구성 (하드웨어/소프트웨어/제어 특징 상세화)
4. 본문 3: 도입 후 개선 효과 (수율, 택트타임, 위치 정밀도, 작업 안정성 등)
5. 결론: 기술 상담 및 샘플 테스트/맞춤 제작 문의 유도 문구
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

[현장 자료 / 추가 사양 텍스트]:
${rawData || '별도 텍스트 자료 없음'}

첨부된 이미지(${images ? images.length : 0}장)와 위 정보를 바탕으로 블로그 포스팅 완성본을 작성해 주세요.
`;

  const parts = [{ text: userPrompt }];
  if (images && Array.isArray(images)) {
    images.forEach(img => {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.data
        }
      });
    });
  }

  // 최신 모델 우선 호출 (필요시 자동 폴백)
  const modelsToTry = ['gemini-3.0-flash', 'gemini-3-flash-preview', 'gemini-2.5-pro'];
  let lastError = '';

  for (const modelName of modelsToTry) {
    try
