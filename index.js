// index.js (ESM) — Notion DB 전체 조회 → JSON + CSV 저장
import { Client } from "@notionhq/client";
import fs from "fs/promises";

// ── 환경변수 사용 추천
const NOTION_API_KEY = "API 키 여기에";
const NOTION_DATABASE_ID = "2709ddfbb30280eeba94ec07afb9bd3e";

if (!NOTION_API_KEY) {
  console.error("❌ NOTION_API_KEY 가 없습니다. env 또는 코드에 넣어주세요.");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

async function fetchAllDatabaseItems(databaseId) {
  const all = [];
  let hasMore = true;
  let startCursor;

  while (hasMore) {
    const res = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: startCursor,
    });
    all.push(...res.results);
    hasMore = res.has_more;
    startCursor = res.next_cursor;
    console.log(`Fetched: ${all.length} items (has_more=${hasMore})`);
  }
  return all;
}

// ── Notion property → 사람이 읽을 값으로 변환
function getPlainValue(property) {
  if (!property) return "";

  switch (property.type) {
    case "title":
      return property.title.map(t => t.plain_text).join("");
    case "rich_text":
      return property.rich_text.map(t => t.plain_text).join("");
    case "number":
      return property.number ?? "";
    case "select":
      return property.select?.name ?? "";
    case "multi_select":
      return property.multi_select.map(s => s.name).join(", ");
    case "status":
      return property.status?.name ?? "";
    case "date": {
      const d = property.date;
      if (!d) return "";
      return d.start + (d.end ? ` → ${d.end}` : "");
    }
    case "checkbox":
      return property.checkbox ? "TRUE" : "FALSE";
    case "url":
      return property.url ?? "";
    case "email":
      return property.email ?? "";
    case "phone_number":
      return property.phone_number ?? "";
    case "people":
      return property.people.map(p => p.name ?? p.id).join(", ");
    case "files":
      return property.files
        .map(f => (f.type === "file" ? f.file.url : f.external?.url))
        .filter(Boolean)
        .join(", ");
    case "relation":
      return property.relation.map(r => r.id).join(", ");
    case "formula": {
      const f = property.formula;
      if (!f) return "";
      if (f.type === "string") return f.string ?? "";
      if (f.type === "number") return f.number ?? "";
      if (f.type === "boolean") return f.boolean ? "TRUE" : "FALSE";
      if (f.type === "date") return f.date?.start ?? "";
      return "";
    }
    case "rollup": {
      const r = property.rollup;
      if (!r) return "";
      // 가장 흔한 text/number/array 케이스 단순화
      if (r.type === "number") return r.number ?? "";
      if (r.type === "date") return r.date?.start ?? "";
      if (r.type === "array") {
        return r.array
          .map(el => {
            // 배열 요소가 propertyItem 형식이라 내부 값 다시 평탄화
            if (el.type === "title") return el.title?.map(t => t.plain_text).join("") ?? "";
            if (el.type === "rich_text") return el.rich_text?.map(t => t.plain_text).join("") ?? "";
            if (el.type === "number") return el.number ?? "";
            if (el.type === "people") return (el.people ?? []).map(p => p.name ?? p.id).join(", ");
            if (el.type === "date") return el.date?.start ?? "";
            if (el.type === "url") return el.url ?? "";
            return "";
          })
          .filter(Boolean)
          .join(" | ");
      }
      return "";
    }
    default:
      return "";
  }
}

// ── Notion item → 평탄한 객체(한 행)
function flattenItem(item) {
  const props = item.properties || {};
  const row = {};
  for (const [key, val] of Object.entries(props)) {
    row[key] = getPlainValue(val);
  }
  return row;
}

// ── 간단 CSV 생성기(모든 값을 큰따옴표로 감싸고 내부 따옴표 이스케이프)
function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach(k => set.add(k));
      return set;
    }, new Set())
  );

  const escape = (value) => {
    const v = value === null || value === undefined ? "" : String(value);
    return `"${v.replace(/"/g, '""')}"`;
  };

  const lines = [];
  lines.push(headers.map(escape).join(","));
  for (const r of rows) {
    const line = headers.map(h => escape(r[h]));
    lines.push(line.join(","));
  }
  return lines.join("\n");
}

(async () => {
  try {
    const items = await fetchAllDatabaseItems(NOTION_DATABASE_ID);

    // JSON 저장
    const jsonOut = {
      database_id: NOTION_DATABASE_ID,
      count: items.length,
      results: items,
      fetched_at: new Date().toISOString(),
    };
    //await fs.writeFile("./notion_dump.json", JSON.stringify(jsonOut, null, 2), "utf8");

    // CSV 저장 (평탄화)
    const rows = items.map(flattenItem);
    const csv = toCSV(rows);
    await fs.writeFile("./notion_dump.csv", csv, "utf8");

    console.log(`✅ Done. CSV: notion_dump.csv (rows=${rows.length})`);
  } catch (err) {
    console.error("❌ Error:", err?.response?.body ?? err);
    process.exit(1);
  }
})();
