/**
 * REAL Tako MCP responses, captured live from https://mcp.tako.com/mcp on
 * 2026-07-30 (tako_search "nvidia revenue", tako_answer "What was US GDP
 * growth in 2024?", tako_available_data "Nvidia").
 *
 * Why this file exists: the first version of these tests used hand-invented
 * fixtures whose shape did not match the API — flat `records` instead of the
 * batch `results[]`, markdown links instead of bare `URL:` lines — and that
 * mismatch hid two real bugs (answer citations never extracted, contents rows
 * never found). Every mapper test derives from this file, so a shape drift
 * upstream shows up as a test failure rather than as silent data loss.
 *
 * Fidelity notes: field names, URLs, ids and values are verbatim. Only volume
 * was trimmed — long descriptions/snippets are clipped with "…", metric
 * definition bullets are dropped, card dataset rows are cut to 3, and the
 * search capture keeps 2 of its 10 web results (its "## Web Results" heading
 * count was adjusted to 2 to stay self-consistent). The answer capture keeps
 * all 3 cards and all 3 web results.
 */

export const SEARCH_TEXT = "## Tako Data (1 card)\n\n### 1. NVIDIA Corporation Total Revenues (Normalized) (Annual)\nThis is a time series bar chart showing 1 series between Jan 30, 2005 and Jan 25, 2026. NVIDIA Corporation Total Revenues (Normalized) (Annual)'s latest value was $215.9B on Jan 25, 2026, up 10,643.0%…\nsemantic_description: NVIDIA Corporation total_revenues (Annual). Bar chart of 1 series. Source: Fiscal.ai.\nexportable: yes · relevance: High · type: chart · freshness: 2026-01-25 · source: Fiscal.ai · source_indexes: data · chart: https://tako.com/card/UB4jWl49yLz-o8VvKhEx/ · embed: https://tako.com/embed/…\n\ndata: 20 of 22 rows in structuredContent.cards[].content (full export via tako_contents).\n\n## Web Results (2)\n\n1. Title: NVIDIA Corporation - NVIDIA Announces Financial Results for First Quarter Fiscal 2027\nURL: https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2027/default.aspx\ninvestor.nvidia.com\n\n---\n\n2. Title: NVIDIA Corporation - NVIDIA Announces Financial Results for Fourth Quarter and Fiscal 2026\nURL: https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-Fourth-Quarter-and-Fiscal-2026/default.aspx\ninvestor.nvidia.com\n\n---\n\n## Source Notes\n\n**Fiscal.ai**: Fiscal.ai is a financial data provider that publishes as-reported and standardized company financials, segments, KPIs, and ratios extracted from filings.\n\n_request_id: 6483df04-7858-4ae4-857e-c0396433e109 · cost: $0.007_";

export const SEARCH_STRUCTURED = {
  "cards": [
    {
      "card_id": "UB4jWl49yLz-o8VvKhEx",
      "title": "NVIDIA Corporation Total Revenues (Normalized) (Annual)",
      "description": "This is a time series bar chart showing 1 series between Jan 30, 2005 and Jan 25, 2026. NVIDIA Corporation Total Revenues (Normalized) (Annual)'s latest value was $215.9B on Jan 25, 2026, up 10,643.0%…",
      "exportable": true,
      "content": {
        "data": null,
        "records": null,
        "dataset": {
          "columns": [
            {
              "name": "Timestamp",
              "type": "datetime"
            },
            {
              "name": "total_revenues - NVIDIA Corporation Total Revenues (Normalized)",
              "type": "number"
            }
          ],
          "rows": [
            [
              "2007-01-28T00:00:00+00:00",
              3068771000
            ],
            [
              "2008-01-27T00:00:00+00:00",
              4097860000
            ],
            [
              "2009-01-25T00:00:00+00:00",
              3424859000
            ]
          ],
          "total_rows": 22,
          "truncated": true,
          "ref": "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/",
          "sources": [
            {
              "name": "Fiscal.ai",
              "index": "data"
            }
          ],
          "provenance": "query"
        },
        "content_format": "json_compact",
        "cost": 0.001,
        "total_rows": 22,
        "truncated": true
      },
      "card_type": "chart",
      "data_freshness": {
        "data_as_of": "2026-01-25",
        "last_updated": "2026-07-30"
      },
      "relevance": "High",
      "webpage_url": "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/",
      "image_url": "https://tako.com/api/v1/image/UB4jWl49yLz-o8VvKhEx/",
      "embed_url": "https://tako.com/embed/UB4jWl49yLz-o8VvKhEx/",
      "sources": [
        {
          "source_name": "Fiscal.ai",
          "source_index": "data"
        }
      ],
      "source_indexes": [
        "data"
      ],
      "semantic_description": "NVIDIA Corporation total_revenues (Annual). Bar chart of 1 series. Source: Fiscal.ai."
    }
  ],
  "web_results": [
    {
      "title": "NVIDIA Corporation - NVIDIA Announces Financial Results for First Quarter Fiscal 2027",
      "url": "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2027/default.aspx",
      "snippet": "NVIDIA Corporation - NVIDIA Announces Financial Results for First Quarter Fiscal 2027 ### NVIDIA Announces Financial Results for First Quarter Fiscal 2027 May 2…",
      "source_name": "investor.nvidia.com",
      "content": {
        "cost": 0.001,
        "truncated": false,
        "data": null,
        "records": null,
        "dataset": null
      }
    },
    {
      "title": "NVIDIA Corporation - NVIDIA Announces Financial Results for Fourth Quarter and Fiscal 2026",
      "url": "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-Fourth-Quarter-and-Fiscal-2026/default.aspx",
      "snippet": "NVIDIA Corporation - NVIDIA Announces Financial Results for Fourth Quarter and Fiscal 2026 ### NVIDIA Announces Financial Results for Fourth Quarter and Fiscal …",
      "source_name": "investor.nvidia.com",
      "content": {
        "cost": 0.001,
        "truncated": false,
        "data": null,
        "records": null,
        "dataset": null
      }
    }
  ],
  "usage": {
    "total_cost_usd": 0.007,
    "compute": {
      "cost_usd": 0.007
    },
    "data": {
      "cost_usd": 0,
      "datasets": 1
    }
  },
  "request_id": "6483df04-7858-4ae4-857e-c0396433e109",
  "pub_id": "UB4jWl49yLz-o8VvKhEx",
  "embed_url": "https://tako.com/embed/UB4jWl49yLz-o8VvKhEx/?dark_mode=auto",
  "image_url": "https://tako.com/api/v1/image/UB4jWl49yLz-o8VvKhEx/?dark_mode=true",
  "dark_mode": true,
  "width": 900,
  "height": 720,
  "sources_glossary": {
    "Fiscal.ai": "Fiscal.ai is a financial data provider that publishes as-reported and standardized company financials, segments, KPIs, and ratios extracted from filings."
  }
};

export const ANSWER_TEXT = "US real GDP grew 2.8% in 2024.\n\n## Cited Data (3 cards)\n\n### 1. United States GDP Growth Rate\nThis country card provides an overview of United States's economic performance, specifically focusing on its real gdp growth rate. The real gdp growth rate of United States is 2.1% as of 2025. The tim…\nsemantic_description: Country indicators for United States: Economic, Demographic, Health, Military, and more. Compared against 2 peer economies. Source: International Monetary Fund.\nexportable: yes · relevance: High · type: card · nodes: `ent::united_states::2a20a06c` (United States), `mt::real_gdp_growth_rate::20463b09` (Real GDP Growth Rate) · source: International Monetary Fun…\n\ndata: 20 of 46 rows in structuredContent.cards[].content (full export via tako_contents).\n\n### 2. United States Real GDP Percent Change\nThis is a time series line chart showing 1 series between Jan 1, 2024 and Oct 1, 2024. United States Real GDP Percent Change's latest value was 1.9% on Oct 1, 2024, up 137.5% since Jan 1, 2024, with a…\nsemantic_description: US GDP growth. Line chart of 1 series. Source: Federal Reserve Bank of St. Louis.\nexportable: yes · relevance: High · type: chart · freshness: 2024-10-01 · nodes: `ent::united_states::2a20a06c` (United States), `mt::real_gdp_percent_cha::7f54c5e7` (Real GDP Percent Change) · source…\n\ndata: 4 rows in structuredContent.cards[].content (full export via tako_contents).\n\n### 3. United States Real GDP Percent Change (Year-over-Year)\nThis is a time series line chart showing 1 series between Jan 1, 2024 and Oct 1, 2024. United States Real GDP Percent Change (Year-over-Year)'s latest value was 2.4% on Oct 1, 2024, down 17.2% since J…\nsemantic_description: US annual GDP growth. Line chart of 1 series. Source: Federal Reserve Bank of St. Louis.\nexportable: yes · relevance: High · type: chart · freshness: 2024-10-01 · nodes: `ent::united_states::2a20a06c` (United States), `mt::real_gdp_percent_cha::2670d59e` (Real GDP Percent Change (Year-ove…\n\ndata: 4 rows in structuredContent.cards[].content (full export via tako_contents).\n\n## Cited Web (3)\n\n1. Title: 4th Quarter and Year 2024\nURL: https://www.bea.gov/sites/default/files/2025-03/gdp4q24-3rd.pdf\nU.S. Bureau of Economic Analysis\n\n---\n\n2. Title: Gross Domestic Product, 4th Quarter and Year 2024 (Second Estimate) | U.S. Bureau of Economic Analysis (BEA)\nURL: https://bea.gov/news/2025/gross-domestic-product-4th-quarter-and-year-2024-second-estimate\nU.S. Bureau of Economic Analysis\n\n---\n\n3. Title: Full text of United States Department of Commerce News : Gross Domestic Product, 4th Quarter and Year 2024 (Third Estimate), GDP by Industry, and Corporate Profits, BEA 25-10 : Full Release …\nURL: https://fraser.stlouisfed.org/title/bureau-economic-analysis-bea-news-releases-6148/gross-domestic-product-4th-quarter-year-2024-third-estimate-gdp-industry-corporate-profits-684142/content/fulltext/bea_newsreleases_20250327\nFederal Reserve Bank of St. Louis · Published: 2025-03-27T00:00:00.000Z\n\n## Source Notes\n\n**International Monetary Fund**: The International Monetary Fund is an international organization that provides economic and financial data alongside assistance to stabilize member economies.\n\n**Federal Reserve Bank of St. Louis**: The Federal Reserve Bank of St. Louis is a regional Reserve Bank of the U.S. Federal Reserve System serving a multi-state district.\n\n_request_id: 69f20461-613b-4299-9a7b-01e92d7a1bba · cost: $0.009_";

export const ANSWER_STRUCTURED = {
  "answer": "US real GDP grew 2.8% in 2024.",
  "cards": [
    {
      "card_id": "-Nrdha0K3vRVkPKxHvBj",
      "title": "United States GDP Growth Rate",
      "description": "This country card provides an overview of United States's economic performance, specifically focusing on its real gdp growth rate. The real gdp growth rate of U…",
      "exportable": true,
      "card_type": "card",
      "relevance": "High",
      "webpage_url": "https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/",
      "image_url": "https://tako.com/api/v1/image/-Nrdha0K3vRVkPKxHvBj/",
      "embed_url": "https://tako.com/embed/-Nrdha0K3vRVkPKxHvBj/",
      "source_indexes": [
        "data"
      ]
    },
    {
      "card_id": "TZrt15wwcTTet7S6B_6x",
      "title": "United States Real GDP Percent Change",
      "description": "This is a time series line chart showing 1 series between Jan 1, 2024 and Oct 1, 2024. United States Real GDP Percent Change's latest value was 1.9% on Oct 1, 2…",
      "exportable": true,
      "card_type": "chart",
      "relevance": "High",
      "webpage_url": "https://tako.com/card/TZrt15wwcTTet7S6B_6x/",
      "image_url": "https://tako.com/api/v1/image/TZrt15wwcTTet7S6B_6x/",
      "embed_url": "https://tako.com/embed/TZrt15wwcTTet7S6B_6x/",
      "source_indexes": [
        "data"
      ]
    },
    {
      "card_id": "kNhKCpGrjmbzox1RaBjn",
      "title": "United States Real GDP Percent Change (Year-over-Year)",
      "description": "This is a time series line chart showing 1 series between Jan 1, 2024 and Oct 1, 2024. United States Real GDP Percent Change (Year-over-Year)'s latest value was…",
      "exportable": true,
      "card_type": "chart",
      "relevance": "High",
      "webpage_url": "https://tako.com/card/kNhKCpGrjmbzox1RaBjn/",
      "image_url": "https://tako.com/api/v1/image/kNhKCpGrjmbzox1RaBjn/",
      "embed_url": "https://tako.com/embed/kNhKCpGrjmbzox1RaBjn/",
      "source_indexes": [
        "data"
      ]
    }
  ],
  "web_results": [
    {
      "title": "4th Quarter and Year 2024",
      "url": "https://www.bea.gov/sites/default/files/2025-03/gdp4q24-3rd.pdf",
      "snippet": "#### EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Thursday, March 27, 2025 BEA 25–10 #### Technical: Lisa Mataloni (GDP) 301-278-9083 GDPNIWD@b…",
      "source_name": "U.S. Bureau of Economic Analysis",
      "content": {
        "cost": 0.001,
        "truncated": false,
        "data": null,
        "records": null,
        "dataset": null
      }
    },
    {
      "title": "Gross Domestic Product, 4th Quarter and Year 2024 (Second Estimate) | U.S. Bureau of Economic Analysis (BEA)",
      "url": "https://bea.gov/news/2025/gross-domestic-product-4th-quarter-and-year-2024-second-estimate",
      "snippet": "Gross Domestic Product, 4th Quarter and Year 2024 (Second Estimate) | U.S. Bureau of Economic Analysis (BEA) # News Release These data have …",
      "source_name": "U.S. Bureau of Economic Analysis",
      "content": {
        "cost": 0.001,
        "truncated": false,
        "data": null,
        "records": null,
        "dataset": null
      }
    },
    {
      "title": "Full text of\n            \tUnited States Department of Commerce News :\n        \tGross Domestic Product, 4th Quarter and Year 2024 (Third Estimate), GDP by Industry, and Corporate Profits, BEA 25-10\n    : Full Release & Tables | FRASER | St. Louis Fed",
      "url": "https://fraser.stlouisfed.org/title/bureau-economic-analysis-bea-news-releases-6148/gross-domestic-product-4th-quarter-year-2024-third-estimate-gdp-industry-corporate-profits-684142/content/fulltext/bea_newsreleases_20250327",
      "snippet": "Full text of United States Department of Commerce News : Gross Domestic Product, 4th Quarter and Year 2024 (Third Estimate), GDP by Industry…",
      "source_name": "Federal Reserve Bank of St. Louis",
      "content": {
        "cost": 0.001,
        "truncated": false,
        "data": null,
        "records": null,
        "dataset": null
      }
    }
  ],
  "usage": {
    "total_cost_usd": 0.009,
    "compute": {
      "cost_usd": 0.009
    },
    "data": {
      "cost_usd": 0,
      "datasets": 3
    }
  },
  "request_id": "69f20461-613b-4299-9a7b-01e92d7a1bba"
};

export const AVAILABLE_DATA_TEXT = "Tako's proprietary data has live, continuously-updated coverage of 1 of 2 matches for \"Nvidia\":\n\n**NVIDIA Corporation (ORG)** — 250+ metrics.\n\n**NVIDIA ARC GmbH (ORG)** — resolved, but Tako holds no metrics for it yet.\n\nAlso matched: NVIDIA Nemotron 3 Nano 4B, NVIDIA Nemotron Nano 9B V2 (Reasoning), NVIDIA Nemotron Nano 9B V2 (Non-reasoning), NVIDIA Nemotron Nano 12B v2 VL (Reasoning), NVIDIA Nemotron 3 Super 120B A1…\n";

export const AVAILABLE_DATA_STRUCTURED = {
  "found": true,
  "query": "Nvidia",
  "next_call": null
};

/**
 * tako_contents is NOT capturable without a TAKO_API_TOKEN (it is gated off
 * the anonymous free tier), so these are hand-written from the tool's upstream
 * output schema: a BATCH response keyed by `results[]`, one entry per
 * requested URL, each carrying `url` plus either `error`, `records` (card
 * rows) or `data` (page text), with per-entry `cost`. The URLs, column names
 * and row values are lifted from the real tako_search capture above, so the
 * payload a card export would return is faithful even though the envelope is
 * reconstructed.
 */
export const CONTENTS_CARD_STRUCTURED = {
  results: [
    {
      url: "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/",
      format: "json_records",
      records: [
        {
          Timestamp: "2024-01-28T00:00:00+00:00",
          "total_revenues - NVIDIA Corporation Total Revenues (Normalized)": 60922000000,
        },
        {
          Timestamp: "2025-01-26T00:00:00+00:00",
          "total_revenues - NVIDIA Corporation Total Revenues (Normalized)": 130497000000,
        },
        {
          Timestamp: "2026-01-25T00:00:00+00:00",
          "total_revenues - NVIDIA Corporation Total Revenues (Normalized)": 215938000000,
        },
      ],
      total_rows: 22,
      truncated: true,
      cost: 0.003,
    },
  ],
  cost: 0.003,
};

export const CONTENTS_CARD_TEXT =
  'Fetched 3 of 22 rows for https://tako.com/card/UB4jWl49yLz-o8VvKhEx/ (json_records).';

/** A web URL: page text under `data`, no `records`. */
export const CONTENTS_WEB_STRUCTURED = {
  results: [
    {
      url: "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2027/default.aspx",
      format: "text",
      records: null,
      data: "NVIDIA today reported record revenue for the first quarter ended April 26, 2026, of $81.6 billion, up 20% from the previous quarter and up 85% from a year ago.",
      total_rows: null,
      truncated: false,
      cost: 0.001,
    },
  ],
  cost: 0.001,
};

export const CONTENTS_WEB_TEXT =
  "NVIDIA today reported record revenue for the first quarter ended April 26, 2026, of $81.6 billion, up 20% from the previous quarter and up 85% from a year ago.";

/**
 * Batch reality: one URL can fail (non-exportable card) while a later one
 * still carries rows. The mapper must skip the failed entry rather than give
 * up on the whole response.
 */
export const CONTENTS_MIXED_STRUCTURED = {
  results: [
    {
      url: "https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/",
      error: "Card is not exportable",
      records: null,
      cost: 0,
    },
    {
      url: "https://tako.com/card/TZrt15wwcTTet7S6B_6x/",
      format: "json_records",
      records: [
        { Timestamp: "2024-07-01T00:00:00+00:00", real_gdp_percent_change: 3.1 },
        { Timestamp: "2024-10-01T00:00:00+00:00", real_gdp_percent_change: 1.9 },
      ],
      total_rows: 4,
      truncated: false,
      cost: 0.002,
    },
  ],
  cost: 0.002,
};

export const CONTENTS_MIXED_TEXT =
  "1 of 2 URLs failed. https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/: Card is not exportable.";

/** Every entry failed — no rows anywhere in the batch. */
export const CONTENTS_ALL_FAILED_STRUCTURED = {
  results: [
    {
      url: "https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/",
      error: "Card is not exportable",
      records: null,
      cost: 0,
    },
  ],
  cost: 0,
};

/** Builds a batch entry with `n` card rows, for exercising the 2000-row cap. */
export function contentsStructuredWithRows(n: number): unknown {
  return {
    results: [
      {
        url: "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/",
        format: "json_records",
        records: Array.from({ length: n }, (_, i) => ({
          Timestamp: `20${String(i % 90).padStart(2, "0")}-01-01T00:00:00+00:00`,
          total_revenues: i,
        })),
        total_rows: n,
        truncated: false,
        cost: 0.01,
      },
    ],
    cost: 0.01,
  };
}
