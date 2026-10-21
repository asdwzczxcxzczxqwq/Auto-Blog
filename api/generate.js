// api/generate.js
export const config = {
  maxDuration: 60, // Vercel 함수 최대 실행 시간(초). 아래 내부 예산은 반드시 이보다 짧게.
};

// ─────────────────────────────────────────────────────────────
// 설정값
// ─────────────────────────────────────────────────────────────
// 모델명은 코드 수정 없이 Vercel 환경변수로 교체 가능하게 분리
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// 503(과부하)·429가 계속될 때 넘어갈 예비 모델. 비워두면 사용 안 함 (예: 더 가벼운 flash-lite 계열)
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';

// maxDuration(60초)보다 5초 여유 → Vercel이 함수를 강제 종료(HTML 504)하기 전에
// 우리가 먼저 JSON 에러를 돌려줘서 화면에 정확한 원인이 뜨게 함
const TOTAL_BUDGET_MS = 55_000;
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_FILES = 5;

// thinkingConfig를 거부한 모델을 기억 → 같은 서버 인스턴스에서는 매번 헛호출하지 않음
const NO_THINKING_CONFIG = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// 시도마다 "자기만의" 타이머를 갖는 fetch (기존 코드는 1·2차 시도가 타이머 하나를 공유했음)
// ─────────────────────────────────────────────────────────────
async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: { message: raw.slice(0, 300) || '빈 응답' } };
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// Gemini 호출: 시간 예산 관리 + 429/503 재시도 + 예비 모델 + thinkingConfig 호환 처리
// ─────────────────────────────────────────────────────────────
async function callGemini(apiKey, { systemInstruction, parts, temperature, maxOutputTokens, responseSchema }) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const models = [PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean);
  let lastError = '알 수 없는 오류';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 5000) {
        throw new Error('AI 응답 대기 시간이 초과되었습니다. 첨부 파일 수를 줄이거나 잠시 후 다시 시도해 주세요.');
      }

      const sendThinkingConfig = !NO_THINKING_CONFIG.has(model);
      const generationConfig = {
        temperature,
        maxOutputTokens,
        ...(responseSchema && { responseMimeType: 'application/json', responseSchema }),
        ...(sendThinkingConfig && { thinkingConfig: { thinkingBudget: 0 } }),
      };

      const body = {
        ...(systemInstruction && { system_instruction: { parts: [{ text: systemInstruction }] } }),
        contents: [{ role: 'user', parts }],
        generationConfig,
      };

      let result;
      try {
        result = await fetchJsonWithTimeout(
          url,
          {
            method: 'POST',
            // API 키를 URL(?key=)이 아닌 헤더로 전송 → 각종 로그에 키가 남지 않음
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
          },
          remaining - 1000
        );
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error('AI 응답이 제한 시간(약 55초) 안에 끝나지 않았습니다. 첨부 파일을 줄이거나 다시 시도해 주세요.');
        }
        // 네트워크 순간 끊김 등 → 잠깐 쉬고 재시도
        lastError = err.message;
        if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleep(800 * attempt);
        continue;
      }

      const { ok, status, data } = result;
      if (ok) return data;

      const message = data?.error?.message || `HTTP ${status}`;
      lastError = `[${model}] ${message}`;

      // thinkingConfig 미지원 모델 → 옵션 빼고 즉시 재시도 (재시도 횟수 차감 없음, 한 번만 발생)
      if (sendThinkingConfig && status === 400 && /thinking/i.test(message)) {
        NO_THINKING_CONFIG.add(model);
        attempt--;
        continue;
      }

      // 400/401/403/404 등은 다시 보내도 결과가 같으므로 바로 종료
      if (!RETRYABLE_STATUS.has(status)) {
        throw new Error(lastError);
      }

      // 429(요청 한도)·503(과부하): 1초 → 2초 (+랜덤) 간격으로 재시도
      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 500);
      }
    }
    // 이 모델로 다 실패 → 예비 모델로 넘어감
  }

  throw new Error(`AI 서버가 일시적으로 혼잡합니다. 1~2분 후 다시 시도해 주세요. (${lastError})`);
}

// 응답에서 텍스트 추출: parts[0]만 보지 않고 모든 텍스트 파트를 합침 + 중단 사유 확인
function extractText(data) {
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  return {
    text,
    finishReason: candidate?.finishReason,
    blockReason: data?.promptFeedback?.blockReason,
  };
}

// 첨부 파일 검증 (개수·형식)
function buildFileParts(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => img && typeof img.data === 'string' && /^(image\/|application\/pdf$)/.test(img.mimeType || ''))
    .slice(0, MAX_FILES)
    .map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } }));
}

const categoryNames = {
  case: '납품 및 현장 구축 성공 사례 (1: 타겟 업종/적용 공정, 2: 현장 이슈/기존 한계점, 3: 적용 솔루션 및 개선 효과)',
  tech: '핵심 장비 및 기술 솔루션 상세 소개 (1: 소개할 장비/솔루션명, 2: 핵심 기술 원리 및 스펙, 3: 현장 도입 시 기대 효과)',
  trouble: '제조 공정 트러블슈팅 및 엔지니어링 노하우 (1: 발생한 공정 문제/불량 현상, 2: 원인 분석, 3: 해결 메커니즘 및 재발 방지책)',
};

// ─────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const { mode, category, input1, input2, input3, rawData, images } = req.body || {};
  const fileParts = buildFileParts(images);
  const categoryLabel = categoryNames[category] || categoryNames.case;

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

현재 선택된 카테고리: [${categoryLabel}]
사용자 힌트/메모: ${input1 || ''} ${rawData || ''}

첨부 자료나 힌트가 있다면 그 내용을 요약해 3칸을 채우고, 아무 자료도 없다면 우리 회사 주력 분야 중 제조 엔지니어가 혹할 만한 실전 블로그 주제를 하나 기획해 3칸을 채워주세요. (고객사 실명은 익명화할 것)
각 칸은 한 줄(40자 내외)로 작성하세요.
`;

    // 정규식으로 JSON을 긁어내는 대신, 모델에게 JSON 형식을 강제
    const responseSchema = {
      type: 'OBJECT',
      properties: {
        input1: { type: 'STRING' },
        input2: { type: 'STRING' },
        input3: { type: 'STRING' },
      },
      required: ['input1', 'input2', 'input3'],
    };

    try {
      const data = await callGemini(apiKey, {
        systemInstruction: null,
        parts: [{ text: recommendPrompt }, ...fileParts],
        temperature: 0.9,
        maxOutputTokens: 1024,
        responseSchema,
      });

      const { text, blockReason } = extractText(data);
      if (blockReason) {
        return res.status(422).json({ error: `입력 자료가 AI 안전 필터에 걸렸습니다 (${blockReason}).` });
      }

      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        try { parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; }
      }
      if (!parsed.input1 && !parsed.input2 && !parsed.input3) {
        return res.status(502).json({ error: 'AI가 추천 결과를 올바른 형식으로 돌려주지 않았습니다. 다시 눌러주세요.' });
      }
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
4. 분량: 본문은 공백 포함 2,500~3,500자 내외로 작성하세요. (너무 길면 응답이 끊길 수 있음)

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
[글 카테고리]: ${categoryLabel}
[핵심 입력 1]: ${input1 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 2]: ${input2 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 3]: ${input3 || '(AI가 문맥에 맞게 자동 설정)'}
[현장 자료 / 추가 사양 텍스트]: ${rawData || '별도 텍스트 자료 없음'}

첨부된 파일과 위 정보를 바탕으로 전문 기술 블로그 포스팅 완성본을 작성해 주세요.
`;

  try {
    const data = await callGemini(apiKey, {
      systemInstruction: SYSTEM_INSTRUCTION,
      parts: [{ text: userPrompt }, ...fileParts],
      temperature: 0.7,
      // 출력 상한 → 생성 시간이 무한정 늘어나지 않게 함 (thinking이 켜지는 모델이면 사고 토큰도 여기 포함됨)
      maxOutputTokens: 6144,
    });

    const { text, finishReason, blockReason } = extractText(data);

    if (blockReason) {
      return res.status(422).json({ error: `입력 자료가 AI 안전 필터에 걸렸습니다 (${blockReason}). 문구나 첨부 파일을 바꿔 다시 시도해 주세요.` });
    }
    if (!text) {
      return res.status(502).json({ error: `AI가 원고를 생성하지 못했습니다 (중단 사유: ${finishReason || '알 수 없음'}). 다시 시도해 주세요.` });
    }

    const notice = finishReason === 'MAX_TOKENS'
      ? '\n\n⚠️ (분량 제한으로 원고가 중간에 끊겼습니다. 다시 생성하거나 마지막 부분만 보완해 주세요.)'
      : '';
    return res.status(200).json({ result: text + notice });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
