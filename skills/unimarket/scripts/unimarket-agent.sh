#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
API_BASE="${BASE_URL%/}/api"
RENDER_BASE_URL="${RENDER_BASE_URL:-http://localhost:3101}"
OUTPUT_MODE="${UNIMARKET_OUTPUT:-pretty}"
JQ_FILTER="${UNIMARKET_JQ_FILTER:-}"
HTTP_RESPONSE_BODY=""
HTTP_RESPONSE_STATUS=""

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency: $1" >&2
    exit 1
  }
}

need curl
need jq
need mktemp

encode() {
  jq -rn --arg value "$1" '$value|@uri'
}

die() {
  echo "$*" >&2
  exit 1
}

auth_arg() {
  if [[ -z "${API_KEY:-}" ]]; then
    die "API_KEY is required for this command"
  fi
  printf 'Authorization: Bearer %s' "$API_KEY"
}

normalize_output_mode() {
  case "$OUTPUT_MODE" in
    pretty|compact|raw) ;;
    *) die "invalid output mode: $OUTPUT_MODE (expected pretty, compact, or raw)" ;;
  esac
}

emit_json() {
  local raw="${1:?json payload required}"

  if [[ -n "$JQ_FILTER" ]]; then
    if [[ "$OUTPUT_MODE" == "compact" ]]; then
      jq -c "$JQ_FILTER" <<<"$raw"
    else
      jq "$JQ_FILTER" <<<"$raw"
    fi
    return
  fi

  case "$OUTPUT_MODE" in
    raw)
      printf '%s\n' "$raw"
      ;;
    compact)
      jq -c . <<<"$raw"
      ;;
    pretty)
      jq . <<<"$raw"
      ;;
  esac
}

perform_request() {
  local method="${1:?method required}"
  local path="${2:?path required}"
  local payload="${3:-}"
  local idem_key="${4:-}"
  local auth_mode="${5:-required}"
  local tmp_body
  local status
  local -a curl_args

  tmp_body="$(mktemp)"
  curl_args=(
    -sS
    -o "$tmp_body"
    -w '%{http_code}'
    -X "$method"
    "${API_BASE}${path}"
    -H 'Accept: application/json'
  )

  if [[ "$auth_mode" == "required" ]]; then
    curl_args+=( -H "$(auth_arg)" )
  fi

  if [[ -n "$payload" ]]; then
    curl_args+=( -H 'Content-Type: application/json' -d "$payload" )
  fi

  if [[ -n "$idem_key" ]]; then
    curl_args+=( -H "Idempotency-Key: ${idem_key}" )
  fi

  if ! status="$(curl "${curl_args[@]}")"; then
    rm -f "$tmp_body"
    die "request failed: ${method} ${path}"
  fi

  HTTP_RESPONSE_BODY="$(cat "$tmp_body")"
  HTTP_RESPONSE_STATUS="$status"
  rm -f "$tmp_body"
}

request_json() {
  local method="${1:?method required}"
  local path="${2:?path required}"
  local payload="${3:-}"
  local idem_key="${4:-}"
  local auth_mode="${5:-required}"

  perform_request "$method" "$path" "$payload" "$idem_key" "$auth_mode"

  if (( HTTP_RESPONSE_STATUS < 200 || HTTP_RESPONSE_STATUS >= 300 )); then
    echo "request failed with status ${HTTP_RESPONSE_STATUS}: ${method} ${path}" >&2
    if jq empty <<<"$HTTP_RESPONSE_BODY" >/dev/null 2>&1; then
      jq . <<<"$HTTP_RESPONSE_BODY" >&2
    else
      printf '%s\n' "$HTTP_RESPONSE_BODY" >&2
    fi
    return 1
  fi

  printf '%s' "$HTTP_RESPONSE_BODY"
}

try_request_json() {
  local method="${1:?method required}"
  local path="${2:?path required}"
  local payload="${3:-}"
  local idem_key="${4:-}"
  local auth_mode="${5:-required}"

  perform_request "$method" "$path" "$payload" "$idem_key" "$auth_mode"
  (( HTTP_RESPONSE_STATUS >= 200 && HTTP_RESPONSE_STATUS < 300 ))
}

json_get() {
  local path="${1:?path required}"
  emit_json "$(request_json GET "$path")"
}

json_post() {
  local path="${1:?path required}"
  local payload="${2:?payload required}"
  local idem_key="${3:-}"
  emit_json "$(request_json POST "$path" "$payload" "$idem_key")"
}

json_put() {
  local path="${1:?path required}"
  local payload="${2:?payload required}"
  emit_json "$(request_json PUT "$path" "$payload")"
}

json_delete() {
  local path="${1:?path required}"
  local payload="${2:?payload required}"
  local idem_key="${3:-}"
  emit_json "$(request_json DELETE "$path" "$payload" "$idem_key")"
}

normalize_references_json() {
  local raw="${1:?references csv required}"
  jq -cn --arg raw "$raw" '
    $raw
    | split(",")
    | map(gsub("^\\s+|\\s+$";""))
    | map(select(length > 0))
    | unique
  '
}

build_orderbook_summaries() {
  local raw="${1:?orderbooks payload required}"
  jq '
    [(.orderbooks // [])[] | {
      reference,
      topBid: (.bids[0].price // null),
      topAsk: (.asks[0].price // null),
      bidDepth5: (([.bids[0:5][]?.size] | add) // 0),
      askDepth5: (([.asks[0:5][]?.size] | add) // 0),
      imbalance: (
        (([.bids[0:5][]?.size] | add) // 0) as $bid
        | (([.asks[0:5][]?.size] | add) // 0) as $ask
        | if ($bid + $ask) > 0 then (($bid - $ask) / ($bid + $ask)) else null end
      )
    }]
  ' <<<"$raw"
}

build_history_summary() {
  local raw="${1:?history payload required}"
  jq '{
    reference,
    interval,
    resampledFrom,
    range,
    summary,
    lastCandles: ((.candles // []) | .[-5:])
  }' <<<"$raw"
}

get_market_descriptor() {
  local market="${1:?market required}"
  local markets_raw descriptor
  markets_raw="$(request_json GET '/markets')"
  descriptor="$(jq -cer --arg market "$market" '.markets[] | select(.id == $market)' <<<"$markets_raw")" || {
    echo "market not found: $market" >&2
    return 1
  }
  printf '%s' "$descriptor"
}

market_supports() {
  local descriptor="${1:?descriptor required}"
  local capability="${2:?capability required}"
  jq -e --arg capability "$capability" '.capabilities | index($capability) != null' <<<"$descriptor" >/dev/null
}

market_default_interval() {
  local descriptor="${1:?descriptor required}"
  jq -r '.priceHistory.defaultInterval // empty' <<<"$descriptor"
}

market_default_lookback() {
  local descriptor="${1:?descriptor required}"
  local interval="${2:?interval required}"
  jq -r --arg interval "$interval" '.priceHistory.defaultLookbacks[$interval] // empty' <<<"$descriptor"
}

usage() {
  cat <<'USAGE'
unimarket-agent.sh - endpoint helper for agents

Environment:
  BASE_URL           default: http://localhost:3100
  RENDER_BASE_URL    default: http://localhost:3101
  API_KEY            required for authenticated commands
  UNIMARKET_OUTPUT   pretty | compact | raw (default: pretty)
  UNIMARKET_JQ_FILTER optional jq filter applied to JSON responses

Global options:
  --pretty           pretty-print JSON output (default)
  --compact          compact JSON output
  --raw              emit raw JSON without jq formatting
  --jq <filter>      apply jq filter to the JSON response
  -h, --help         show help

Core commands:
  register [user_name]
  register-safe [user_name] [env_file]
  markets
  markets-summary
  browse <market> [sort] [limit] [offset]
  search <market> [query] [sort] [limit] [offset]
  constraints <market> <reference>
  quote <market> <reference>
  quotes <market> <references_csv>
  orderbook <market> <reference>
  orderbooks <market> <references_csv>
  funding <market> <reference>
  fundings <market> <references_csv>
  resolve <market> <reference>
  history <market> <reference> [interval] [lookback] [as_of]
  history-summary <market> <reference> [interval] [lookback] [as_of]
  history-range <market> <reference> <interval> <start_time> <end_time>

Analysis document commands:
  analysis-schema
  analysis-context <market> <reference> [interval] [lookback] [as_of]
  analysis-list [market] [reference] [status] [interval]
  analysis-validate <document_json_file>
  analysis-create <document_json_file> <reasoning> [supersedes_id]
  analysis-update <analysis_id> <document_json_file> <reasoning>
  analysis-publish <analysis_id> <reasoning>
  analysis-render-metadata <analysis_id>
  analysis-image-url <market> <reference> <analysis_id> [scope]
  analysis-inspect <market> <reference> <analysis_id> [scope]
  analysis-render <market> <reference> <analysis_id> <output_png> [scope]

Trading and audit commands:
  buy <market> <reference> <quantity> <reasoning> [limit_price] [idempotency_key]
  sell <market> <reference> <quantity> <reasoning> [limit_price] [idempotency_key]
  order-json <payload_json> [idempotency_key]
  cancel <order_id> <reasoning> [idempotency_key]
  orders [query_string]
  orders-open [limit] [offset]
  orders-history [limit] [offset]
  orders-status <status> [limit] [offset]
  account
  portfolio
  positions [query_string]
  snapshot [orders_view] [limit] [offset]
  scan <market> <references_csv> [interval] [lookback] [as_of]
  timeline [limit] [offset]
  journal-add <content> [tags_csv] [idempotency_key]
  journal-list [query_string]
  reconcile <reasoning>
  events [since_event_id]

Notes:
  - Use orders-open instead of guessing status=open.
  - Use snapshot for account + portfolio + positions + orders in one call.
  - Use scan on a supplied reference list to gather constraints, quotes, orderbook summaries,
    optional funding, and optional history summaries in one structured response.
USAGE
}

parse_global_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pretty)
        OUTPUT_MODE="pretty"
        shift
        ;;
      --compact)
        OUTPUT_MODE="compact"
        shift
        ;;
      --raw)
        OUTPUT_MODE="raw"
        shift
        ;;
      --jq)
        JQ_FILTER="${2:?jq filter required}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        break
        ;;
    esac
  done

  REMAINING_ARGS=("$@")
}

normalize_output_mode
parse_global_options "$@"
set -- "${REMAINING_ARGS[@]}"
cmd="${1:-help}"
shift || true

case "$cmd" in
  register)
    user_name="${1:-agent-$(date +%s)}"
    payload="$(jq -nc --arg userName "$user_name" '{userName: $userName}')"
    response="$(request_json POST '/auth/register' "$payload" '' none)"
    emit_json "$response"

    api_key="$(jq -r '.apiKey // empty' <<<"$response")"
    user_id="$(jq -r '.userId // empty' <<<"$response")"
    account_id="$(jq -r '.account.id // empty' <<<"$response")"
    if [[ -n "$api_key" ]]; then
      cat <<EXPORTS

# export for current shell:
export API_KEY=${api_key}
export USER_ID=${user_id}
export ACCOUNT_ID=${account_id}
EXPORTS
    fi
    ;;
  register-safe)
    user_name="${1:-agent-$(date +%s)}"
    env_file="${2:-.state/agent.env}"
    payload="$(jq -nc --arg userName "$user_name" '{userName: $userName}')"
    response="$(request_json POST '/auth/register' "$payload" '' none)"
    api_key="$(jq -r '.apiKey // empty' <<<"$response")"
    user_id="$(jq -r '.userId // empty' <<<"$response")"
    account_id="$(jq -r '.account.id // empty' <<<"$response")"
    [[ -n "$api_key" && -n "$user_id" && -n "$account_id" ]] || die 'register-safe failed to retrieve credentials'
    mkdir -p "$(dirname "$env_file")"
    cat > "$env_file" <<ENV
BASE_URL=$BASE_URL
API_KEY=$api_key
USER_ID=$user_id
ACCOUNT_ID=$account_id
ENV
    chmod 600 "$env_file"
    safe_payload="$(jq -cn \
      --arg userId "$user_id" \
      --arg envFile "$env_file" \
      --arg accountId "$account_id" \
      --arg accountName "$(jq -r '.account.name // empty' <<<"$response")" \
      --arg createdAt "$(jq -r '.account.createdAt // empty' <<<"$response")" \
      --argjson balance "$(jq '.account.balance // null' <<<"$response")" \
      '{registered:true, userId:$userId, envFile:$envFile, apiKeyStored:true, account:{id:$accountId, name:$accountName, balance:$balance, createdAt:$createdAt}}'
    )"
    emit_json "$safe_payload"
    ;;
  markets)
    json_get '/markets'
    ;;
  markets-summary)
    raw="$(request_json GET '/markets')"
    summary="$(jq '{
      markets: [.markets[] | {
        id,
        name,
        description,
        referenceFormat,
        capabilities,
        browseOptions,
        searchSortOptions,
        priceHistory: (
          if .priceHistory == null then null else {
            supportedIntervals: .priceHistory.supportedIntervals,
            defaultInterval: .priceHistory.defaultInterval,
            defaultLookbacks: .priceHistory.defaultLookbacks,
            maxCandles: .priceHistory.maxCandles,
            supportsCustomRange: .priceHistory.supportsCustomRange,
            supportsResampling: .priceHistory.supportsResampling
          } end
        )
      }]
    }' <<<"$raw")"
    emit_json "$summary"
    ;;
  browse)
    market="${1:?market required}"
    sort="${2:-}"
    limit="${3:-20}"
    offset="${4:-0}"
    json_get "/markets/${market}/browse?limit=${limit}&offset=${offset}${sort:+&sort=$(encode "$sort")}" 
    ;;
  search)
    market="${1:?market required}"
    query="${2:-}"
    sort=""
    limit="20"
    offset="0"
    if [[ -n "${3:-}" ]]; then
      if [[ "${3}" =~ ^[0-9]+$ ]]; then
        limit="${3}"
        offset="${4:-0}"
      else
        sort="${3}"
        limit="${4:-20}"
        offset="${5:-0}"
      fi
    fi
    if [[ -z "$query" ]]; then
      json_get "/markets/${market}/browse?limit=${limit}&offset=${offset}${sort:+&sort=$(encode "$sort")}"
    else
      json_get "/markets/${market}/search?q=$(encode "$query")&limit=${limit}&offset=${offset}${sort:+&sort=$(encode "$sort")}"
    fi
    ;;
  constraints)
    market="${1:?market required}"
    reference="${2:?reference required}"
    json_get "/markets/${market}/trading-constraints?reference=$(encode "$reference")"
    ;;
  quote)
    market="${1:?market required}"
    reference="${2:?reference required}"
    json_get "/markets/${market}/quote?reference=$(encode "$reference")"
    ;;
  quotes)
    market="${1:?market required}"
    references="${2:?references csv required}"
    json_get "/markets/${market}/quotes?references=$(encode "$references")"
    ;;
  orderbook)
    market="${1:?market required}"
    reference="${2:?reference required}"
    json_get "/markets/${market}/orderbook?reference=$(encode "$reference")"
    ;;
  orderbooks)
    market="${1:?market required}"
    references="${2:?references csv required}"
    json_get "/markets/${market}/orderbooks?references=$(encode "$references")"
    ;;
  funding)
    market="${1:?market required}"
    reference="${2:?reference required}"
    json_get "/markets/${market}/funding?reference=$(encode "$reference")"
    ;;
  fundings)
    market="${1:?market required}"
    references="${2:?references csv required}"
    json_get "/markets/${market}/fundings?references=$(encode "$references")"
    ;;
  resolve)
    market="${1:?market required}"
    reference="${2:?reference required}"
    json_get "/markets/${market}/resolve?reference=$(encode "$reference")"
    ;;
  history)
    market="${1:?market required}"
    reference="${2:?reference required}"
    interval="${3:-1h}"
    lookback="${4:-7d}"
    as_of="${5:-}"
    json_get "/markets/${market}/price-history?reference=$(encode "$reference")&interval=$(encode "$interval")&lookback=$(encode "$lookback")${as_of:+&asOf=$(encode "$as_of")}" 
    ;;
  history-summary)
    market="${1:?market required}"
    reference="${2:?reference required}"
    descriptor="$(get_market_descriptor "$market")"
    interval="${3:-$(market_default_interval "$descriptor")}" 
    lookback="${4:-$(market_default_lookback "$descriptor" "$interval")}" 
    as_of="${5:-}"
    raw="$(request_json GET "/markets/${market}/price-history?reference=$(encode "$reference")&interval=$(encode "$interval")&lookback=$(encode "$lookback")${as_of:+&asOf=$(encode "$as_of")}")"
    emit_json "$(build_history_summary "$raw")"
    ;;
  history-range)
    market="${1:?market required}"
    reference="${2:?reference required}"
    interval="${3:?interval required}"
    start_time="${4:?start_time required}"
    end_time="${5:?end_time required}"
    json_get "/markets/${market}/price-history?reference=$(encode "$reference")&interval=$(encode "$interval")&startTime=$(encode "$start_time")&endTime=$(encode "$end_time")"
    ;;
  analysis-schema)
    json_get "/analysis/schema"
    ;;
  analysis-context)
    market="${1:?market required}"
    reference="${2:?reference required}"
    interval="${3:-1d}"
    lookback="${4:-1y}"
    as_of="${5:-}"
    json_get "/analysis/context?market=$(encode "$market")&reference=$(encode "$reference")&interval=$(encode "$interval")&lookback=$(encode "$lookback")${as_of:+&asOf=$(encode "$as_of")}"
    ;;
  analysis-list)
    market="${1:-}"
    reference="${2:-}"
    status="${3:-}"
    interval="${4:-}"
    query="limit=20"
    [[ -n "$market" ]] && query="${query}&market=$(encode "$market")"
    [[ -n "$reference" ]] && query="${query}&reference=$(encode "$reference")"
    [[ -n "$status" ]] && query="${query}&status=$(encode "$status")"
    [[ -n "$interval" ]] && query="${query}&interval=$(encode "$interval")"
    json_get "/analysis/documents?${query}"
    ;;
  analysis-validate)
    document_file="${1:?document json file required}"
    [[ -f "$document_file" ]] || die "analysis document not found: $document_file"
    document_json="$(jq -c . "$document_file")"
    payload="$(jq -nc --argjson document "$document_json" '{document:$document}')"
    json_post "/analysis/validate" "$payload"
    ;;
  analysis-create)
    document_file="${1:?document json file required}"
    reasoning="${2:?reasoning required}"
    supersedes_id="${3:-}"
    [[ -f "$document_file" ]] || die "analysis document not found: $document_file"
    document_json="$(jq -c . "$document_file")"
    payload="$(jq -nc \
      --argjson document "$document_json" \
      --arg reasoning "$reasoning" \
      --arg supersedesId "$supersedes_id" \
      '{document:$document,reasoning:$reasoning} + (if $supersedesId == "" then {} else {supersedesId:$supersedesId} end)')"
    json_post "/analysis/documents" "$payload"
    ;;
  analysis-update)
    analysis_id="${1:?analysis id required}"
    document_file="${2:?document json file required}"
    reasoning="${3:?reasoning required}"
    [[ -f "$document_file" ]] || die "analysis document not found: $document_file"
    document_json="$(jq -c . "$document_file")"
    payload="$(jq -nc --argjson document "$document_json" --arg reasoning "$reasoning" '{document:$document,reasoning:$reasoning}')"
    json_put "/analysis/documents/${analysis_id}" "$payload"
    ;;
  analysis-publish)
    analysis_id="${1:?analysis id required}"
    reasoning="${2:?reasoning required}"
    payload="$(jq -nc --arg reasoning "$reasoning" '{reasoning:$reasoning}')"
    json_post "/analysis/documents/${analysis_id}/publish" "$payload"
    ;;
  analysis-render-metadata)
    analysis_id="${1:?analysis id required}"
    json_get "/analysis/documents/${analysis_id}/render-metadata"
    ;;
  analysis-image-url)
    market="${1:?market required}"
    reference="${2:?reference required}"
    analysis_id="${3:?analysis id required}"
    scope="${4:-chart}"
    printf '%s/render?market=%s&reference=%s&documentId=%s&scope=%s\n' \
      "${RENDER_BASE_URL%/}" "$(encode "$market")" "$(encode "$reference")" "$(encode "$analysis_id")" "$(encode "$scope")"
    ;;
  analysis-render)
    market="${1:?market required}"
    reference="${2:?reference required}"
    analysis_id="${3:?analysis id required}"
    output_png="${4:?output png required}"
    scope="${5:-chart}"
    render_url="${RENDER_BASE_URL%/}/render?market=$(encode "$market")&reference=$(encode "$reference")&documentId=$(encode "$analysis_id")&scope=$(encode "$scope")"
    curl -fsS "$render_url" -o "$output_png"
    printf '%s\n' "$output_png"
    ;;
  analysis-inspect)
    market="${1:?market required}"
    reference="${2:?reference required}"
    analysis_id="${3:?analysis id required}"
    scope="${4:-chart}"
    inspect_url="${RENDER_BASE_URL%/}/inspect?market=$(encode "$market")&reference=$(encode "$reference")&documentId=$(encode "$analysis_id")&scope=$(encode "$scope")"
    emit_json "$(curl -fsS "$inspect_url")"
    ;;
  buy|sell)
    market="${1:?market required}"
    reference="${2:?reference required}"
    quantity="${3:?quantity required}"
    reasoning="${4:?reasoning required}"
    limit_price="${5:-}"
    idem_key="${6:-}"
    side="$cmd"
    if [[ -n "$limit_price" ]]; then
      payload="$(jq -nc \
        --arg market "$market" \
        --arg reference "$reference" \
        --arg side "$side" \
        --arg reasoning "$reasoning" \
        --argjson quantity "$quantity" \
        --argjson limitPrice "$limit_price" \
        '{market:$market,reference:$reference,side:$side,type:"limit",quantity:$quantity,limitPrice:$limitPrice,reasoning:$reasoning}')"
    else
      payload="$(jq -nc \
        --arg market "$market" \
        --arg reference "$reference" \
        --arg side "$side" \
        --arg reasoning "$reasoning" \
        --argjson quantity "$quantity" \
        '{market:$market,reference:$reference,side:$side,type:"market",quantity:$quantity,reasoning:$reasoning}')"
    fi
    json_post '/orders' "$payload" "$idem_key"
    ;;
  order-json)
    payload="${1:?payload json required}"
    idem_key="${2:-}"
    jq -e . >/dev/null <<<"$payload" || die "payload must be valid JSON"
    json_post '/orders' "$payload" "$idem_key"
    ;;
  cancel)
    order_id="${1:?order id required}"
    reasoning="${2:?reasoning required}"
    idem_key="${3:-}"
    payload="$(jq -nc --arg reasoning "$reasoning" '{reasoning:$reasoning}')"
    json_delete "/orders/${order_id}" "$payload" "$idem_key"
    ;;
  orders)
    query_string="${1:-}"
    if [[ -n "$query_string" ]]; then
      json_get "/orders?${query_string}"
    else
      json_get '/orders'
    fi
    ;;
  orders-open)
    limit="${1:-20}"
    offset="${2:-0}"
    json_get "/orders?view=open&limit=${limit}&offset=${offset}"
    ;;
  orders-history)
    limit="${1:-20}"
    offset="${2:-0}"
    json_get "/orders?view=history&limit=${limit}&offset=${offset}"
    ;;
  orders-status)
    status="${1:?status required}"
    limit="${2:-20}"
    offset="${3:-0}"
    case "$status" in
      pending|filled|cancelled|rejected) ;;
      *) die "invalid order status: $status" ;;
    esac
    json_get "/orders?status=$(encode "$status")&limit=${limit}&offset=${offset}"
    ;;
  account)
    json_get '/account'
    ;;
  portfolio)
    json_get '/account/portfolio'
    ;;
  positions)
    query_string="${1:-}"
    if [[ -n "$query_string" ]]; then
      json_get "/positions?${query_string}"
    else
      json_get '/positions'
    fi
    ;;
  snapshot)
    orders_view="${1:-open}"
    limit="${2:-20}"
    offset="${3:-0}"
    case "$orders_view" in
      all|open|history) ;;
      *) die "invalid orders view: $orders_view" ;;
    esac
    account_raw="$(request_json GET '/account')"
    portfolio_raw="$(request_json GET '/account/portfolio')"
    positions_raw="$(request_json GET '/positions')"
    orders_raw="$(request_json GET "/orders?view=$(encode "$orders_view")&limit=${limit}&offset=${offset}")"
    payload="$(jq -nc \
      --arg ordersView "$orders_view" \
      --argjson account "$account_raw" \
      --argjson portfolio "$portfolio_raw" \
      --argjson positionsResponse "$positions_raw" \
      --argjson ordersResponse "$orders_raw" \
      '{
        ordersView: $ordersView,
        account: $account,
        portfolio: $portfolio,
        positions: ($positionsResponse.positions // []),
        orders: ($ordersResponse.orders // []),
        counts: {
          positions: (($positionsResponse.positions // []) | length),
          orders: (($ordersResponse.orders // []) | length)
        }
      }'
    )"
    emit_json "$payload"
    ;;
  scan)
    market="${1:?market required}"
    references_input="${2:?references csv required}"
    descriptor="$(get_market_descriptor "$market")"
    references_json="$(normalize_references_json "$references_input")"
    references_csv="$(jq -r 'join(",")' <<<"$references_json")"
    reference_count="$(jq 'length' <<<"$references_json")"
    (( reference_count > 0 )) || die 'scan requires at least one reference'

    interval="${3:-}"
    lookback="${4:-}"
    as_of="${5:-}"

    if market_supports "$descriptor" 'priceHistory'; then
      [[ -n "$interval" ]] || interval="$(market_default_interval "$descriptor")"
      [[ -n "$lookback" ]] || lookback="$(market_default_lookback "$descriptor" "$interval")"
    fi

    quotes_raw='{"quotes":[],"errors":[]}'
    orderbooks_raw='{"orderbooks":[],"errors":[]}'
    fundings_raw='{"fundings":[],"errors":[]}'

    if market_supports "$descriptor" 'quote'; then
      quotes_raw="$(request_json GET "/markets/${market}/quotes?references=$(encode "$references_csv")")"
    fi
    if market_supports "$descriptor" 'orderbook'; then
      orderbooks_raw="$(request_json GET "/markets/${market}/orderbooks?references=$(encode "$references_csv")")"
    fi
    if market_supports "$descriptor" 'funding'; then
      fundings_raw="$(request_json GET "/markets/${market}/fundings?references=$(encode "$references_csv")")"
    fi

    tmpdir="$(mktemp -d)"
    trap 'rm -rf "$tmpdir"' EXIT
    : > "$tmpdir/constraints.ndjson"
    : > "$tmpdir/constraint-errors.ndjson"
    : > "$tmpdir/histories.ndjson"
    : > "$tmpdir/history-errors.ndjson"

    while IFS= read -r reference; do
      [[ -n "$reference" ]] || continue

      if try_request_json GET "/markets/${market}/trading-constraints?reference=$(encode "$reference")"; then
        printf '%s\n' "$HTTP_RESPONSE_BODY" >> "$tmpdir/constraints.ndjson"
      else
        jq -cn \
          --arg reference "$reference" \
          --argjson status "$HTTP_RESPONSE_STATUS" \
          --arg body "$HTTP_RESPONSE_BODY" \
          '{reference:$reference, status:$status, error:(($body | fromjson? // {message:$body}))}' >> "$tmpdir/constraint-errors.ndjson"
      fi

      if market_supports "$descriptor" 'priceHistory' && [[ -n "$interval" && -n "$lookback" ]]; then
        history_path="/markets/${market}/price-history?reference=$(encode "$reference")&interval=$(encode "$interval")&lookback=$(encode "$lookback")${as_of:+&asOf=$(encode "$as_of")}" 
        if try_request_json GET "$history_path"; then
          build_history_summary "$HTTP_RESPONSE_BODY" >> "$tmpdir/histories.ndjson"
          printf '\n' >> "$tmpdir/histories.ndjson"
        else
          jq -cn \
            --arg reference "$reference" \
            --argjson status "$HTTP_RESPONSE_STATUS" \
            --arg body "$HTTP_RESPONSE_BODY" \
            '{reference:$reference, status:$status, error:(($body | fromjson? // {message:$body}))}' >> "$tmpdir/history-errors.ndjson"
        fi
      fi
    done < <(jq -r '.[]' <<<"$references_json")

    constraints_json="$(jq -s '.' "$tmpdir/constraints.ndjson" 2>/dev/null || printf '[]')"
    constraint_errors_json="$(jq -s '.' "$tmpdir/constraint-errors.ndjson" 2>/dev/null || printf '[]')"
    histories_json="$(jq -s '.' "$tmpdir/histories.ndjson" 2>/dev/null || printf '[]')"
    history_errors_json="$(jq -s '.' "$tmpdir/history-errors.ndjson" 2>/dev/null || printf '[]')"
    orderbook_summaries_json="$(build_orderbook_summaries "$orderbooks_raw")"

    payload="$(jq -nc \
      --arg market "$market" \
      --argjson descriptor "$descriptor" \
      --argjson references "$references_json" \
      --arg interval "$interval" \
      --arg lookback "$lookback" \
      --arg asOf "$as_of" \
      --argjson constraints "$constraints_json" \
      --argjson constraintErrors "$constraint_errors_json" \
      --argjson quotesResponse "$quotes_raw" \
      --argjson orderbooksResponse "$orderbooks_raw" \
      --argjson orderbookSummaries "$orderbook_summaries_json" \
      --argjson fundingsResponse "$fundings_raw" \
      --argjson histories "$histories_json" \
      --argjson historyErrors "$history_errors_json" \
      '{
        market: $market,
        marketDescriptor: $descriptor,
        references: $references,
        request: {
          interval: (if $interval == "" then null else $interval end),
          lookback: (if $lookback == "" then null else $lookback end),
          asOf: (if $asOf == "" then null else $asOf end)
        },
        constraints: $constraints,
        constraintErrors: $constraintErrors,
        quotes: ($quotesResponse.quotes // []),
        quoteErrors: ($quotesResponse.errors // []),
        orderbookSummaries: $orderbookSummaries,
        orderbookErrors: ($orderbooksResponse.errors // []),
        fundings: ($fundingsResponse.fundings // []),
        fundingErrors: ($fundingsResponse.errors // []),
        histories: $histories,
        historyErrors: $historyErrors
      }'
    )"
    emit_json "$payload"
    trap - EXIT
    rm -rf "$tmpdir"
    ;;
  timeline)
    limit="${1:-20}"
    offset="${2:-0}"
    json_get "/account/timeline?limit=${limit}&offset=${offset}"
    ;;
  journal-add)
    content="${1:?content required}"
    tags_csv="${2:-}"
    idem_key="${3:-}"
    if [[ -n "$tags_csv" ]]; then
      tags_json="$(printf '%s' "$tags_csv" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length>0))')"
      payload="$(jq -nc --arg content "$content" --argjson tags "$tags_json" '{content:$content,tags:$tags}')"
    else
      payload="$(jq -nc --arg content "$content" '{content:$content}')"
    fi
    json_post '/journal' "$payload" "$idem_key"
    ;;
  journal-list)
    query_string="${1:-limit=20&offset=0}"
    json_get "/journal?${query_string}"
    ;;
  reconcile)
    reasoning="${1:?reasoning required}"
    payload="$(jq -nc --arg reasoning "$reasoning" '{reasoning:$reasoning}')"
    json_post '/orders/reconcile' "$payload"
    ;;
  events)
    since="${1:-}"
    if [[ -n "$since" ]]; then
      curl -sS -N "${API_BASE}/events?since=$(encode "$since")" -H "$(auth_arg)"
    else
      curl -sS -N "${API_BASE}/events" -H "$(auth_arg)"
    fi
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "unknown command: ${cmd}" >&2
    usage
    exit 1
    ;;
esac
