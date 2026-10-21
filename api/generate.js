// api/generate.js
export const config = {
  // Fluid compute가 켜진 프로젝트는 Hobby 플랜도 최대 300초까지 허용됨.
  // 배포가 실패하면 Vercel 프로젝트 Settings → Functions에서 Fluid Compute가 켜져 있는지 확인.
  maxDuration: 180,
};

// ─────────────────────────────────────────────────────────────
// 설정값 (모두 Vercel 환경변수로 덮어쓸 수 있음)
// ─────────────────────────────────────────────────────────────
// gemini-3.8-flash는 사고(thinking)를 끌 수 없고 최저 단계도 low라서 첫 글자까지 60초 넘게 걸리는 일이 생김.
// → 사고를 minimal까지 낮출 수 있는 3.6-flash를 기본으로, 막히면 더 가벼운 3.5-flash-lite로 자동 전환.
// (Vercel 환경변수 GEMINI_MODEL / GEMINI_FALLBACK_MODEL / GEMINI_THINKING_LEVEL로 언제든 변경 가능)
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'minimal';

const TOTAL_BUDGET_MS = 170_000;     // maxDuration(180초)보다 10초 여유
const FIRST_BYTE_TIMEOUT_MS = 40_000; // 첫 응답이 40초 안에 없으면 예비 모델로 넘어감
const IDLE_TIMEOUT_MS = 60_000;       // 스트리밍 도중 글자가 60초간 안 들어오면 중단
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_FILES = 5;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// thinkingConfig를 거부한 모델을 기억 → 같은 서버 인스턴스에서는 매번 헛호출하지 않음
const NO_THINKING_CONFIG = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildBody({ systemInstruction, parts, contents, temperature, maxOutputTokens, responseSchema }, useThinking) {
  return {
    ...(systemInstruction && { system_instruction: { parts: [{ text: systemInstruction }] } }),
    contents: contents || [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(responseSchema && { responseMimeType: 'application/json', responseSchema }),
      ...(useThinking && { thinkingConfig: { thinkingLevel: THINKING_LEVEL } }),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Gemini 요청 열기: 응답이 "시작"될 때까지 재시도·예비 모델 처리
// 성공하면 아직 본문을 읽지 않은 response를 돌려줌 (스트리밍/일반 공용)
// ─────────────────────────────────────────────────────────────
const ALL_MODELS = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL].filter(Boolean))];

async function openGemini(apiKey, opts, { stream, deadline, models = ALL_MODELS }) {
  let lastError = '알 수 없는 오류';

  for (const model of models) {
    const url = `${API_BASE}/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 10_000) {
        throw new Error(`AI 응답 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (${lastError})`);
      }

      const useThinking = !NO_THINKING_CONFIG.has(model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(FIRST_BYTE_TIMEOUT_MS, remaining - 5000));

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(buildBody(opts, useThinking)),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          lastError = `[${model}] 응답 시작 지연`;
          break; // 같은 모델로 다시 기다리지 않고 예비 모델로
        }
        lastError = err.message; // 네트워크 순간 끊김 → 재시도
        if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleep(800 * attempt);
        continue;
      }
      clearTimeout(timer);

      if (response.ok) return { response, controller, model };

      const raw = await response.text().catch(() => '');
      let message;
      try { message = JSON.parse(raw)?.error?.message; } catch { /* HTML 등 */ }
      message = message || raw.slice(0, 300) || `HTTP ${response.status}`;
      lastError = `[${model}] ${message}`;

      // thinkingLevel을 모르는 모델(예: 2.5 계열로 바꾼 경우) → 옵션 빼고 즉시 재시도
      if (useThinking && response.status === 400 && /thinking/i.test(message)) {
        NO_THINKING_CONFIG.add(model);
        attempt--;
        continue;
      }

      if (!RETRYABLE_STATUS.has(response.status)) throw new Error(lastError);

      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 500);
      }
    }
  }

  throw new Error(`AI 서버 응답에 실패했습니다. 1~2분 후 다시 시도해 주세요. (${lastError})`);
}

// SSE(서버 전송 이벤트) 응답을 조각 단위로 읽기
async function* readSSE(response, controller) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idle;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  arm();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      let m;
      while ((m = buffer.match(/\r?\n\r?\n/))) {
        const event = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data) yield JSON.parse(data);
      }
    }
  } finally {
    clearTimeout(idle);
  }
}

function textOf(candidate) {
  return (candidate?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

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

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const startedAt = Date.now();
  const { mode, category, input1, input2, input3, rawData, images } = req.body || {};
  const fileParts = buildFileParts(images);
  const categoryLabel = categoryNames[category] || categoryNames.case;

  // ==========================================================
  // 모드 1: [🪄 AI 자동 추천 / 빈칸 채우기]  (짧은 응답 → 일반 호출)
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
      const { response, controller, model } = await openGemini(
        apiKey,
        { parts: [{ text: recommendPrompt }, ...fileParts], temperature: 0.9, maxOutputTokens: 4096, responseSchema },
        { stream: false, deadline }
      );

      const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
      let data;
      try {
        data = JSON.parse(await response.text());
      } finally {
        clearTimeout(timer);
      }
      console.log(JSON.stringify({ mode: 'recommend', model, ms: Date.now() - startedAt, usage: data?.usageMetadata }));

      if (data?.promptFeedback?.blockReason) {
        return res.status(422).json({ error: `입력 자료가 AI 안전 필터에 걸렸습니다 (${data.promptFeedback.blockReason}).` });
      }

      const text = textOf(data?.candidates?.[0]);
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
      const message = err.name === 'AbortError' ? 'AI 응답이 너무 오래 걸려 중단되었습니다. 다시 눌러주세요.' : err.message;
      console.error(JSON.stringify({ mode: 'recommend', ms: Date.now() - startedAt, error: message }));
      return res.status(500).json({ error: message });
    }
  }

  // ==========================================================
  // 모드 2: [✨ 블로그 원고 자동 생성하기]  (스트리밍: 글이 써지는 대로 화면에 전달)
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
4. 분량: 본문은 공백 포함 2,500~3,500자 내외로 작성하세요.

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

  const baseOpts = {
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.7,
    // 사고(thinking) 토큰도 이 한도에 포함되므로 넉넉하게
    maxOutputTokens: 8192,
  };
  const baseContents = [{ role: 'user', parts: [{ text: userPrompt }, ...fileParts] }];

  // 1) 응답이 시작될 때까지는 재시도 가능 → 실패하면 JSON 에러로 응답
  let current;
  try {
    current = await openGemini(apiKey, { ...baseOpts, contents: baseContents }, { stream: true, deadline });
  } catch (err) {
    console.error(JSON.stringify({ mode: 'generate', ms: Date.now() - startedAt, error: err.message }));
    return res.status(500).json({ error: err.message });
  }

  // 2) 응답이 시작되면 글자를 받는 즉시 브라우저로 흘려보냄
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const MAX_CONTINUATIONS = 2; // 도중에 끊겼을 때 이어쓰기 최대 횟수
  const modelsUsed = [current.model];
  const streamErrors = [];
  let total = '';
  let finishReason;
  let blockReason;
  let usage;

  try {
    while (true) {
      const deadlineTimer = setTimeout(() => current.controller.abort(), Math.max(1000, deadline - Date.now()));
      try {
        for await (const chunk of readSSE(current.response, current.controller)) {
          if (chunk.error) throw new Error(chunk.error.message || 'AI 스트림 오류');
          if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finishReason = candidate.finishReason;
          const text = textOf(candidate);
          if (text) {
            total += text;
            res.write(text);
          }
        }
        break; // 정상 완료
      } catch (err) {
        const reason = err.name === 'AbortError' ? '응답 지연' : err.message;
        streamErrors.push(`[${current.model}] ${reason}`);

        // 3) 도중에 끊기면(과부하 등) 다른 모델을 우선으로, 끊긴 지점부터 이어쓰기
        if (streamErrors.length > MAX_CONTINUATIONS || deadline - Date.now() < 20_000) {
          res.write(`\n\n⚠️ (생성 중 오류: ${reason}. 다시 생성해 주세요.)`);
          break;
        }
        const order = [...ALL_MODELS.filter((m) => m !== current.model), current.model];
        const contents = total
          ? [
              ...baseContents,
              { role: 'model', parts: [{ text: total }] },
              {
                role: 'user',
                parts: [{
                  text: '위 원고가 작성 도중 끊겼습니다. 끊긴 지점의 바로 다음 글자부터 같은 형식과 문체로 끝까지 이어서 작성하세요. 이미 쓴 내용을 반복하거나 앞에 다른 말을 붙이지 마세요.',
                }],
              },
            ]
          : baseContents;
        try {
          current = await openGemini(apiKey, { ...baseOpts, contents }, { stream: true, deadline, models: order });
          modelsUsed.push(current.model);
          finishReason = undefined;
        } catch (err2) {
          res.write(`\n\n⚠️ (생성 중 오류: ${reason}. 이어쓰기도 실패했습니다: ${err2.message})`);
          break;
        }
      } finally {
        clearTimeout(deadlineTimer);
      }
    }

    if (blockReason) {
      res.write(`\n\n⚠️ 입력 자료가 AI 안전 필터에 걸렸습니다 (${blockReason}). 문구나 첨부 파일을 바꿔 다시 시도해 주세요.`);
    } else if (!total) {
      res.write(`⚠️ AI가 원고를 생성하지 못했습니다 (중단 사유: ${finishReason || '알 수 없음'}). 다시 시도해 주세요.`);
    } else if (finishReason === 'MAX_TOKENS') {
      res.write('\n\n⚠️ (분량 제한으로 원고가 중간에 끊겼습니다. 다시 생성하거나 마지막 부분만 보완해 주세요.)');
    }
  } catch (err) {
    res.write(`\n\n⚠️ (생성 중 오류: ${err.message}. 다시 생성해 주세요.)`);
  } finally {
    // Vercel 대시보드 → Logs에서 소요 시간·사용 모델·끊김 기록을 확인할 수 있음
    console.log(JSON.stringify({
      mode: 'generate',
      models: modelsUsed,
      ms: Date.now() - startedAt,
      chars: total.length,
      finishReason,
      streamErrors,
      usage,
    }));
    res.end();
  }
}
