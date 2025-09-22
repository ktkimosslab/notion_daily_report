// index.js — Notion DB 지난주 월~금(KST)만 CSV 저장 (경계안전 + 로컬 재필터)
import { Client } from "@notionhq/client";
import fs from "fs/promises";

// ── 여기에 직접 입력 (또는 process.env로 대체)
const NOTION_API_KEY = "API 키 여기에";
const NOTION_DATABASE_ID = "2709ddfbb30280eeba94ec07afb9bd3e";

// 날짜 프로퍼티 이름 (네 DB 기준)
const DATE_PROPERTY = "시작 일자";

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("❌ NOTION_API_KEY / NOTION_DATABASE_ID 누락");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

// ── 유틸: YYYY-MM-DD
const toYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// ── 지난주 월 00:00 ~ 금 23:59:59 (KST) → YYYY-MM-DD (포함 범위)
function getLastWeekYMDRangeKST() {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowKST = new Date(Date.now() + KST_OFFSET_MS);

  // 월=0, ..., 일=6 되게 조정
  const mondayIndex = (nowKST.getDay() + 6) % 7;

  // 이번주 월요일 00:00 (KST)
  const thisMon = new Date(nowKST);
  thisMon.setHours(0, 0, 0, 0);
  thisMon.setDate(thisMon.getDate() - mondayIndex);

  // 지난주 월~금
  const lastMon = new Date(thisMon);
  lastMon.setDate(thisMon.getDate() - 7);

  const lastFri = new Date(lastMon);
  lastFri.setDate(lastMon.getDate() + 4);

  return { startYMD: toYMD(lastMon), endYMD: toYMD(lastFri) };
}

// ── Notion: 지난주 월~금만 가져오기 (AND 필터 + 페이지네이션)
async function fetchItemsLastWeek(databaseId) {
  const { startYMD, endYMD } = getLastWeekYMDRangeKST();
  console.log(`🔎 Range (KST, inclusive): ${startYMD} ~ ${endYMD}`);

  const all = [];
  let hasMore = true;
  let startCursor;

  while (hasMore) {
    const res = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: startCursor,
      filter: {
        and: [
          { property: DATE_PROPERTY, date: { on_or_after: startYMD } },
          { property: DATE_PROPERTY, date: { on_or_before: endYMD } },
        ],
      },
    });
    all.push(...res.results);
    hasMore = res.has_more;
    startCursor = res.next_cursor;
    console.log(`Fetched: ${all.length} (has_more=${hasMore})`);
  }

  // 로컬 재필터 (엣지 케이스 방지)
  const inRange = (isoOrYmd) => {
    if (!isoOrYmd) return false;
    const ymd = isoOrYmd.slice(0, 10);
    return ymd >= startYMD && ymd <= endYMD;
  };

  const filtered = all.filter((item) => {
    const p = item.properties?.[DATE_PROPERTY];
    const v = p?.date?.start ?? "";
    return inRange(v);
  });

  const dropped = all.length - filtered.length;
  if (dropped > 0) console.warn(`⚠️ Dropped ${dropped} out-of-range rows from API.`);

  return filtered;
}

// ── property → 사람이 읽는 값
function getPlainValue(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return p.title.map(t => t.plain_text).join("");
    case "rich_text": return p.rich_text.map(t => t.plain_text).join("");
    case "number": return p.number ?? "";
    case "select": return p.select?.name ?? "";
    case "multi_select": return p.multi_select.map(s => s.name).join(", ");
    case "status": return p.status?.name ?? "";
    case "date": {
      const d = p.date;
      if (!d) return "";
      return d.start + (d.end ? ` → ${d.end}` : "");
    }
    case "checkbox": return p.checkbox ? "TRUE" : "FALSE";
    case "url": return p.url ?? "";
    case "email": return p.email ?? "";
    case "phone_number": return p.phone_number ?? "";
    case "people": return p.people.map(x => x.name ?? x.id).join(", ");
    case "files":
      return (p.files ?? [])
        .map(f => (f.type === "file" ? f.file.url : f.external?.url))
        .filter(Boolean).join(", ");
    case "relation": return (p.relation ?? []).map(r => r.id).join(", ");
    default: return "";
  }
}

// ── 1개 페이지 → 평탄화된 객체(행)
function flattenItem(item) {
  const props = item.properties ?? {};
  const row = {};
  for (const [k, v] of Object.entries(props)) row[k] = getPlainValue(v);
  return row;
}

// ── CSV 생성기
function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(","));
  return lines.join("\n");
}

// ── 실행
(async () => {
  try {
    const items = await fetchItemsLastWeek(NOTION_DATABASE_ID);
    const rows = items.map(flattenItem);
    const csv = toCSV(rows);
    await fs.writeFile("./notion_dump.csv", csv, "utf8");
    console.log(`✅ Done. CSV: notion_dump.csv (rows=${rows.length})`);
  } catch (err) {
    console.error("❌ Error:", err?.response?.body ?? err);
    process.exit(1);
  }
})();
