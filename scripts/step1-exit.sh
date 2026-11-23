#!/usr/bin/env bash
#
# Step 1 的出口检查：用 curl 模拟一个服务账号客户端，走通三步。
#
#   ① 用 client_credentials 向管控平面换访问令牌
#   ② 带着令牌读模型目录，调网关的 Chat Completions
#   ③ 从 PostgreSQL 里读出这次调用落下的那一条用量
#
# 前置：一个终端里执行过 pnpm stack:up，另一个终端里 pnpm dev 正在运行。
#       pnpm dev 会生成 deploy/dev/apps.env，本脚本从那里读地址与凭据。
#
# 对数据库只读：连接时把会话设成只读，写操作会被数据库直接拒绝。
# 令牌与密钥不会出现在进程列表里，脚本也不打印它们。
# 兼容 macOS 自带的 bash 3.2。那个版本会把紧跟在变量名后面的全角标点算进变量名，
# 所以凡是变量后面直接接中文或全角符号的地方都写成了 ${变量}。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPS_ENV="$ROOT/deploy/dev/apps.env"

fail() {
  echo
  echo "未通过：$*" >&2
  exit 1
}

# 把标准输入的内容和一段 Node 代码交给 node 执行。代码里用 text 取到输入的内容，
# 用 argv 取到代码之外的其余参数。几处 JSON 解析共用这一段读入逻辑，免得各写一遍。
node_stdin() {
  NODE_STDIN="$1" node -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => new Function("text", "argv", "require", process.env.NODE_STDIN)(text, process.argv.slice(1), require));
  ' "${@:2}"
}

# json_get <字段路径>：从标准输入的 JSON 里取一个标量。可以写 a.b 或 a.0.b 这样的路径。
json_get() {
  node_stdin '
    let value = JSON.parse(text);
    for (const key of argv[0].split(".")) {
      if (value === null || typeof value !== "object") process.exit(2);
      value = value[key];
    }
    if (value === undefined || value === null || typeof value === "object") process.exit(2);
    process.stdout.write(String(value));
  ' "$1"
}

# urlencode <文本>
urlencode() {
  printf '%s' "$1" | node_stdin 'process.stdout.write(encodeURIComponent(text));'
}

TOKEN=""
HTTP_STATUS=""
RESPONSE=""

# http <方法> <地址> [<请求体> [<请求体类型>]]
# 结果放在 RESPONSE（响应体）和 HTTP_STATUS 里。
# 这个函数必须直接调用，不能放在管道里：那样它在子 shell 里执行，结果传不回来。
# TOKEN 有值时会带上它，并且只经管道交给 curl 当请求头，不写进命令行参数。
# TOKEN 为空时，请求体可以写成 @-，表示从标准输入读。换令牌的请求体里有密钥，走这条路。
http() {
  local method="$1" url="$2" body="${3:-}" type="${4:-application/json}"
  local data=()
  if [ -n "$body" ]; then
    data=(-H "content-type: $type" --data-binary "$body")
  fi
  local out
  if [ -n "$TOKEN" ]; then
    out="$(
      printf 'authorization: Bearer %s\n' "$TOKEN" |
        curl -sS -X "$method" "$url" -H @- ${data[@]+"${data[@]}"} -w '\n%{http_code}'
    )" || fail "连不上 ${url}。三个服务在运行吗（先执行 pnpm dev）？"
  else
    out="$(curl -sS -X "$method" "$url" ${data[@]+"${data[@]}"} -w '\n%{http_code}')" \
      || fail "连不上 ${url}。三个服务在运行吗（先执行 pnpm dev）？"
  fi
  HTTP_STATUS="${out##*$'\n'}"
  RESPONSE="${out%$'\n'*}"
}

# db_query <查询>：在开发栈的数据库容器里执行，一行一条记录，字段之间用竖线隔开。
# PGOPTIONS 把这个会话设成只读，这是“脚本对数据库只读”的保证所在。
# 查询经标准输入交给 psql：它只在这种模式下做变量替换，用 -c 传语句时 :'client_id' 会原样发给数据库。
# 调用方的标识就是通过这个变量传进去的，不拼进 SQL 文本。
db_query() {
  docker compose --env-file "$ROOT/deploy/dev/stack.env" -f "$ROOT/deploy/dev/compose.yaml" \
    exec -T -e "PGOPTIONS=-c default_transaction_read_only=on" postgres \
    psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -v "client_id=$SERVICE_ID" \
    -U "$DB_USER" -d "$DB_NAME" -f - <<< "$1" \
    || fail "查询数据库失败。开发栈在运行吗（先执行 pnpm stack:up）？"
}

# ---------------------------------------------------------------------------
# 准备：从 apps.env 取本脚本要用的值
# ---------------------------------------------------------------------------

[ -f "$APPS_ENV" ] || fail "找不到 deploy/dev/apps.env。先执行一次 pnpm dev，它会生成这个文件。"
for tool in curl node docker; do
  command -v "$tool" >/dev/null 2>&1 || fail "需要 ${tool}。"
done

# 只读这个文件、只取用得到的几项，不把整个文件 source 进来。
API_URL=""
GATEWAY_URL=""
SERVICE_ID=""
SERVICE_SECRET=""
DB_USER=""
DB_NAME=""
MODEL=""
while IFS='=' read -r name value; do
  case "$name" in
    api) API_URL="$value" ;;
    gateway) GATEWAY_URL="$value" ;;
    serviceId) SERVICE_ID="$value" ;;
    serviceSecret) SERVICE_SECRET="$value" ;;
    dbUser) DB_USER="$value" ;;
    dbName) DB_NAME="$value" ;;
    model) MODEL="$value" ;;
  esac
done < <(
  node_stdin '
    const lines = text.split("\n");
    const env = (name) => {
      const prefix = name + "=";
      const line = lines.find((item) => item.startsWith(prefix));
      if (line === undefined) die(`apps.env 里没有 ${name}`);
      return line.slice(prefix.length).trim();
    };
    const envJson = (name) => {
      try {
        return JSON.parse(env(name));
      } catch {
        die(`apps.env 里的 ${name} 不是合法的 JSON`);
      }
    };
    function die(message) {
      console.error(`${message}。删掉这个文件后重新执行 pnpm dev，或者检查它的内容。`);
      process.exit(2);
    }

    // 服务账号客户端：清单里唯一一个走 client_credentials、并且带密钥的那个。
    const services = envJson("ZM_OIDC_CLIENTS_JSON").filter(
      (client) => Array.isArray(client.grantTypes) && client.grantTypes.includes("client_credentials"),
    );
    if (services.length !== 1 || !services[0].clientId || !services[0].clientSecret) {
      die("客户端清单里应当正好有一个带密钥的服务账号客户端");
    }
    const model = envJson("ZM_SEED_MODELS_JSON")[0];
    if (!model?.id) die("模型目录里至少要有一个模型");
    let database;
    try {
      database = new URL(env("ZM_DATABASE_URL"));
    } catch {
      die("apps.env 里的 ZM_DATABASE_URL 不是合法的地址");
    }

    const row = (name, value) => {
      if (value === undefined || String(value).includes("\n")) process.exit(2);
      process.stdout.write(`${name}=${value}\n`);
    };
    row("api", env("ZM_PUBLIC_BASE_URL").replace(/\/+$/, ""));
    row("gateway", env("ZM_GATEWAY_BASE_URL").replace(/\/+$/, ""));
    row("serviceId", services[0].clientId);
    row("serviceSecret", services[0].clientSecret);
    row("dbUser", decodeURIComponent(database.username));
    row("dbName", database.pathname.replace(/^\/+/, ""));
    row("model", model.id);
  ' < "$APPS_ENV"
)
for required in API_URL GATEWAY_URL SERVICE_ID SERVICE_SECRET DB_USER DB_NAME MODEL; do
  [ -n "${!required}" ] || fail "没能从 deploy/dev/apps.env 读到要用的值。"
done

echo "管控平面 $API_URL"
echo "网关       $GATEWAY_URL"

# ---------------------------------------------------------------------------
# 不带令牌调网关：应当在转到上游之前就被拒绝
# ---------------------------------------------------------------------------

http POST "$GATEWAY_URL/gateway/v1/chat/completions"
[ "$HTTP_STATUS" = "401" ] || fail "不带令牌调网关应当是 401，实际是 HTTP ${HTTP_STATUS}：$RESPONSE"
echo "不带令牌调网关：HTTP $HTTP_STATUS"

# ---------------------------------------------------------------------------
# ① 换令牌
# ---------------------------------------------------------------------------

FORM="grant_type=client_credentials&scope=model:invoke&client_id=$(urlencode "$SERVICE_ID")&client_secret=$(urlencode "$SERVICE_SECRET")"
http POST "$API_URL/connect/token" @- 'application/x-www-form-urlencoded' < <(printf '%s' "$FORM")
[ "$HTTP_STATUS" = "200" ] || fail "换令牌没有成功（HTTP ${HTTP_STATUS}）：$RESPONSE"
TOKEN="$(json_get access_token <<< "$RESPONSE")" || fail "换令牌的响应里没有 access_token：$RESPONSE"
echo "① 换令牌：HTTP ${HTTP_STATUS}，范围 $(json_get scope <<< "$RESPONSE")，有效期 $(json_get expires_in <<< "$RESPONSE") 秒"

# ---------------------------------------------------------------------------
# ② 模型目录与网关
# ---------------------------------------------------------------------------

http GET "$API_URL/em/v1/models"
[ "$HTTP_STATUS" = "200" ] || fail "读模型目录失败（HTTP ${HTTP_STATUS}）：$RESPONSE"
MODEL_IDS="$(node_stdin '
    const ids = JSON.parse(text).models.map((model) => model.id);
    if (!ids.includes(argv[0])) process.exit(2);
    process.stdout.write(ids.join("、"));
  ' "$MODEL" <<< "$RESPONSE")" || fail "模型目录里没有种子模型 ${MODEL}：$RESPONSE"
echo "② 模型目录：$MODEL_IDS"

# 网关对非流式请求是先写完用量再返回，所以拿到响应时库里的那一行已经成立。
BEFORE="$(db_query 'SELECT count(*) FROM usage_events')"

http POST "$GATEWAY_URL/gateway/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"step1-exit\"}]}"
[ "$HTTP_STATUS" = "200" ] || fail "调网关失败（HTTP ${HTTP_STATUS}）：$RESPONSE"
REPLY_TEXT="$(json_get choices.0.message.content <<< "$RESPONSE")" || fail "网关的响应里没有回复内容：$RESPONSE"
PROMPT_TOKENS="$(json_get usage.prompt_tokens <<< "$RESPONSE")" || fail "网关的响应里没有 usage：$RESPONSE"
COMPLETION_TOKENS="$(json_get usage.completion_tokens <<< "$RESPONSE")" || fail "网关的响应里没有 usage：$RESPONSE"
TOTAL_TOKENS="$(json_get usage.total_tokens <<< "$RESPONSE")" || fail "网关的响应里没有 usage：$RESPONSE"
echo "   调网关：HTTP $HTTP_STATUS"
echo "   回复：$REPLY_TEXT"
echo "   用量：输入 ${PROMPT_TOKENS}，输出 ${COMPLETION_TOKENS}，合计 $TOTAL_TOKENS"

# ---------------------------------------------------------------------------
# ③ 数据库里的那一条用量
# ---------------------------------------------------------------------------

AFTER="$(db_query 'SELECT count(*) FROM usage_events')"
[ "$AFTER" -eq "$((BEFORE + 1))" ] || fail "用量应当正好多一条：调用前 $BEFORE 条，调用后 $AFTER 条。"

ROW="$(db_query "
  SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
         subject_type, subject_id, model, upstream_model, status_code, stream,
         input_tokens, output_tokens, total_tokens, usage_source, error_kind
  FROM usage_events
  WHERE client_id = :'client_id'
  ORDER BY occurred_at DESC, id DESC
  LIMIT 1
")"
IFS='|' read -r occurred subject_type subject_id model upstream_model status_code stream \
  input_tokens output_tokens total_tokens usage_source error_kind <<< "$ROW"

[ "$subject_type" = "service" ] && [ "$subject_id" = "$SERVICE_ID" ] || fail "用量的归属不对：$subject_type / $subject_id"
[ "$model" = "$MODEL" ] && [ "$upstream_model" = "$MODEL" ] || fail "用量的模型不对：$model / $upstream_model"
[ "$status_code" = "200" ] && [ "$stream" = "0" ] || fail "用量的状态不对：HTTP ${status_code}，stream=$stream"
[ "$input_tokens" = "$PROMPT_TOKENS" ] && [ "$output_tokens" = "$COMPLETION_TOKENS" ] && [ "$total_tokens" = "$TOTAL_TOKENS" ] \
  || fail "用量里的 token 数与响应里的不一致：$input_tokens / $output_tokens / $total_tokens"
[ "$usage_source" = "upstream" ] && [ "$error_kind" = "" ] || fail "用量的来源或错误标记不对：$usage_source / $error_kind"

echo "③ 数据库：用量从 $BEFORE 条变为 $AFTER 条，最新一条如下"
echo "   时间（UTC）  $occurred"
echo "   归属        $subject_type:$subject_id"
echo "   模型        ${model}（上游名 ${upstream_model}）"
echo "   状态        HTTP ${status_code}，非流式"
echo "   token       $input_tokens / $output_tokens / $total_tokens"
echo "   来源        $usage_source"
echo
echo "通过：Step 1 的出口成立。"
