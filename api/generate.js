// api/generate.js
import {
  PUBLISHED_TITLES,
  COMPANY_PROFILE,
  ITEM_CATALOG,
  CATALOG_TEXT,
  APPLICATION_CASES,
  formatItem,
  MARKUP_RULES,
  COMMON_RULES,
  CATEGORY_STYLES,
  CATEGORY_EXAMPLES,
  GEO_RULES,
  selectTerms,
  formatTerms,
} from './_blog-style.js';

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
  trouble: '장비 운영 가이드 및 트러블슈팅 노하우 (1: 발생한 공정 문제/불량 현상, 2: 원인 분석, 3: 해결 메커니즘 및 재발 방지책)',
  product: '제품·소모품 모델별 특징 정리 (1: 정리할 제품군/모델 번호, 2: 구분 기준(타입·용제·용도 등), 3: 추천 대상/문의 유도 포인트)',
};

const titleList = PUBLISHED_TITLES.map((t) => `- ${t}`).join('\n');

// 기존 글 제목에 키워드가 들어 있으면 "이미 다룬 아이템"
const titlesJoined = PUBLISHED_TITLES.join(' ').toLowerCase();
const isCovered = (item) => item.keywords.some((k) => titlesJoined.includes(k.toLowerCase()));

// 아이템 선택: 사용자가 고른 것이 있으면 그것, 없으면 아직 안 다룬 아이템을 4배 더 잘 뽑히게 무작위 선택
function pickItem(itemId) {
  const chosen = ITEM_CATALOG.find((i) => i.id === itemId);
  if (chosen) return chosen;
  const weighted = ITEM_CATALOG.map((i) => ({ i, w: isCovered(i) ? 1 : 4 }));
  let r = Math.random() * weighted.reduce((s, x) => s + x.w, 0);
  for (const { i, w } of weighted) {
    r -= w;
    if (r <= 0) return i;
  }
  return ITEM_CATALOG[0];
}

const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

// "2026년 10월" 형태의 기준일 (한국 시간)
function baseMonthKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월`;
}

// ─────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // 화면의 "다룰 아이템" 목록용
  if (req.method === 'GET') {
    return res.status(200).json({
      items: ITEM_CATALOG.map((i) => ({ id: i.id, group: i.group, name: i.name, covered: isCovered(i) })),
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const startedAt = Date.now();
  const { mode, category, input1, input2, input3, rawData, images, itemId } = req.body || {};
  const geo = req.body?.geo !== false; // AI 검색 인용 최적화 (기본 켜짐)
  const fileParts = buildFileParts(images);
  const cat = categoryNames[category] ? category : 'case';
  const categoryLabel = categoryNames[cat];

  // ==========================================================
  // 모드 1: [🪄 AI 자동 추천 / 빈칸 채우기]  (짧은 응답 → 일반 호출)
  // ==========================================================
  if (mode === 'recommend') {
    const hasHint = Boolean((input1 || '').trim() || (rawData || '').trim() || fileParts.length);
    // 힌트가 없을 때만 아이템을 골라 주제의 중심으로 삼음 (사용자가 아이템을 지정했으면 항상 그 아이템)
    const item = itemId || !hasHint ? pickItem(itemId) : null;
    const industryHint = item ? randomOf(item.uses.split(',').map((s) => s.trim()).filter(Boolean)) : '';

    const recommendPrompt = `
당신은 산업용 마킹·비전 검사 솔루션 기업 브이큐브(V-CUBE)의 네이버 블로그를 운영하는 기술 마케터입니다.

[회사 개요]
${COMPANY_PROFILE}
[실제 적용 사례]
${APPLICATION_CASES}
[이미 블로그에 올린 글]
${titleList}

현재 선택된 카테고리: [${categoryLabel}]
사용자 힌트/메모: ${input1 || ''} ${rawData || ''}
${item ? `
[이번 글의 중심 아이템 — 반드시 이 아이템을 주인공으로]
${formatItem(item)}
${isCovered(item) ? '※ 이 아이템은 블로그에서 이미 다룬 적이 있으므로, 기존 글과 다른 업종·다른 문제·후속편 각도로 기획할 것.' : '※ 아직 블로그에서 다루지 않은 아이템입니다.'}
[먼저 검토할 적용 업종] ${industryHint} (더 자연스러운 업종이 있으면 '적용' 목록 안에서 바꿔도 됨)
` : ''}
${hasHint ? '첨부 자료나 힌트의 내용을 중심으로 3칸을 채우세요. 위 아이템과 관련이 있으면 아이템의 사실을 활용하세요.' : ''}
주제 기획 기준:
- "아이템 × 업종 × 그 업종 현장이 실제로 겪는 문제" 조합으로 하나의 구체적인 주제를 만들 것.
- 이미 올린 글과 같은 주제는 피하고, 다른 업종 적용·후속편·심화편 각도로 확장할 것.
- 선택된 카테고리의 글 유형에 맞을 것 (예: 제품/소모품 정리면 모델·재질·소모품 비교, 운영 가이드면 증상과 점검 포인트).
- 고객이 실제로 검색할 만한 키워드(모델명, 불량 현상, 업종+장비명)가 들어가게.
${geo ? '- 사람들이 검색창이나 AI에게 실제로 묻는 질문(장비 선택 기준, 방식 비교, 불량 원인, 규격 대응)에 답이 되는 주제를 우선할 것.\n' : ''}- 아이템의 사양은 위 '사실'에 있는 것만 언급. 고객사 실명은 익명화.
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
      return res.status(200).json({
        recommendation: parsed,
        item: item ? { id: item.id, name: item.name, covered: isCovered(item) } : null,
      });
    } catch (err) {
      const message = err.name === 'AbortError' ? 'AI 응답이 너무 오래 걸려 중단되었습니다. 다시 눌러주세요.' : err.message;
      console.error(JSON.stringify({ mode: 'recommend', ms: Date.now() - startedAt, error: message }));
      return res.status(500).json({ error: message });
    }
  }

  // ==========================================================
  // 모드 2: [✨ 블로그 원고 자동 생성하기]  (스트리밍: 글이 써지는 대로 화면에 전달)
  // ==========================================================
  const focusItem = ITEM_CATALOG.find((i) => i.id === itemId) || null;

  // AI 인용 최적화: 글감과 관련된 용어만 사전에서 골라 넣음
  const termSource = [focusItem?.name, focusItem?.facts, focusItem?.uses, input1, input2, input3, rawData].filter(Boolean).join(' ');
  const terms = geo ? selectTerms(termSource, focusItem?.group) : [];
  const geoBlock = geo
    ? `${GEO_RULES.replace('{기준일}', baseMonthKST())}
[용어 사전 — 용어 박스와 본문 설명은 이 정의를 기준으로]
${formatTerms(terms)}
`
    : '';
  const bodyFormat = geo
    ? `[📸 대표 사진]
## 📌 한눈에 보기
- (요약 1) / - (요약 2) / - (요약 3)
(본문: 글 유형과 표기 규칙대로, 용어 박스 3~5개와 질문형 소제목 2~3개 포함)
## ❓ 자주 묻는 질문
Q. (질문)
A. (답)
… 3~5쌍
(문의 유도)
※ 이 글은 ${baseMonthKST()} 기준으로 작성되었습니다.
[📸 사진: 명함 배너 | 캡션: 견적 문의 · 무료 샘플 테스트]`
    : '(본문: 위 글 유형과 표기 규칙대로)';

  // 블로그 문체·견본·기존 글 목록·아이템 카탈로그는 api/_blog-style.js에서 관리
  const SYSTEM_INSTRUCTION = `
당신은 산업용 마킹·비전 검사 솔루션 기업 브이큐브(V-CUBE)의 네이버 블로그 글을 대신 쓰는 담당자입니다.
아래 견본 글은 실제로 이 블로그에 올라간 글입니다. 견본의 말투, 문장 길이, 줄바꿈, 소제목 방식, 강조 방식,
사진·영상 배치를 최대한 그대로 따라 쓰세요. 단, 견본의 문장을 그대로 베끼지 말고 새 주제에 맞게 새로 쓰세요.

[회사 개요]
${COMPANY_PROFILE}
[취급 아이템 카탈로그 — 제품 사양과 강점은 여기 적힌 사실만 사용]
${CATALOG_TEXT}

[실제 적용 사례]
${APPLICATION_CASES}
[타겟 독자]
제조·물류 현장의 생산기술팀, 설비 엔지니어, 구매·자동화 담당자, 그리고 장비 모델명이나 불량 현상을 검색해 들어오는 기존 장비 사용자.

${COMMON_RULES}
${CATEGORY_STYLES[cat]}
${MARKUP_RULES}
${geoBlock}
[이미 올린 글 — 관련 글 링크에만 사용, 같은 내용 반복 금지]
${titleList}

[출력 형식]
📌 추천 제목
1. (제목)
2. (제목)
3. (제목)
---
${bodyFormat}
---
🏷️ 추천 해시태그
(#태그 10개 내외를 한 줄에)

[견본 글]
${CATEGORY_EXAMPLES[cat]}
`;

  const userPrompt = `
[글 카테고리]: ${categoryLabel}
[핵심 입력 1]: ${input1 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 2]: ${input2 || '(AI가 문맥에 맞게 자동 설정)'}
[핵심 입력 3]: ${input3 || '(AI가 문맥에 맞게 자동 설정)'}
[현장 자료 / 추가 사양 텍스트]: ${rawData || '별도 텍스트 자료 없음'}
${focusItem ? `[중심 아이템]: ${focusItem.name} — 카탈로그의 이 아이템 사실을 본문의 핵심 근거로 사용하고, 함께 쓰면 좋은 다른 취급 아이템(예: 마킹기 + 바코드 검증 + LMS)이 있으면 자연스럽게 엮을 것.` : '[중심 아이템]: 입력 내용에 맞는 취급 아이템을 카탈로그에서 골라 근거로 사용할 것.'}

첨부된 파일과 위 정보를 바탕으로 전문 기술 블로그 포스팅 완성본을 작성해 주세요.
`;

  const baseOpts = {
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.7,
    // 사고(thinking) 토큰도 이 한도에 포함되므로 넉넉하게 (요약·용어·FAQ가 추가되어 상향)
    maxOutputTokens: 12288,
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
      geo,
      terms: terms.map((t) => t.id),
      ms: Date.now() - startedAt,
      chars: total.length,
      finishReason,
      streamErrors,
      usage,
    }));
    res.end();
  }
}
