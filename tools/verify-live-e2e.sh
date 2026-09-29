#!/usr/bin/env bash
#
# End-to-end verify dsh-rerun-turn in a throwaway DSH profile: boot the real
# web app in a sandbox DSH_HOME on a free port, create a scratch session with
# three short model turns, rerun the MIDDLE turn through the plugin's own
# /apply route, wait for the background regeneration + replay, then read the
# live derived context and assert the infix splice (A B C1' D').
#
# The caller's ~/.dsh is never touched, and the sandbox process is the only
# thing this script ever kills - by pid, never by pattern. Credentials are
# copied in so the scratch turns can call the deployment's real model.
#
#   bash tools/verify-live-e2e.sh
#   KEEP=1 bash tools/verify-live-e2e.sh        # leave the sandbox for inspection
#
# Never boot this against port 3080: that is the user's own live DSH.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
NODE_BIN="${NODE_BIN:-node}"
PROFILE="dsh-rerun-turn-verify"
ROUTE="/dsh-rerun-turn"

RESERVED_PORTS="3080 3099"

fail() { echo "✗ $1" >&2; exit 1; }
ok()   { echo "✓ $1"; }
step() { echo; echo "── $1"; }

DSH_RUN() {
  export DSH_HOME="$HOME_DIR"
  case "$DSH_BIN" in
    *.js|*.mjs|*.cjs) "$NODE_BIN" "$DSH_BIN" "$@" ;;
    *) "$DSH_BIN" "$@" ;;
  esac
}

command -v "$NODE_BIN" >/dev/null 2>&1 || fail "找不到 node（用 NODE_BIN=<路径> 指定）"

# --- sandbox home -----------------------------------------------------------
if [ -n "${DSH_HOME:-}" ]; then
  HOME_DIR="$DSH_HOME"
  CLEANUP_HOME=0
else
  HOME_DIR="/tmp/dsh-rerun-turn-verify-$$"
  CLEANUP_HOME=1
fi
LOG_DIR="$(mktemp -d)"
mkdir -p "$HOME_DIR" || fail "无法创建沙箱 DSH_HOME: $HOME_DIR"

stop_sandbox() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
    PID=""
  fi
  [ -n "${PORT:-}" ] || return 0
  local holder tries=0
  holder="$(lsof -nP -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  while [ -n "$holder" ] && [ "$tries" -lt 5 ]; do
    for pid in $holder; do kill "$pid" 2>/dev/null; done
    sleep 1
    tries=$((tries + 1))
    holder="$(lsof -nP -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  done
  for pid in $holder; do kill -KILL "$pid" 2>/dev/null; done
}

cleanup() {
  stop_sandbox
  rm -rf "$LOG_DIR"
  if [ "${KEEP:-0}" = "1" ]; then
    echo "沙箱保留在 $HOME_DIR"
  elif [ "$CLEANUP_HOME" = "1" ]; then
    rm -rf "$HOME_DIR"
  fi
}
trap cleanup EXIT

# --- port -------------------------------------------------------------------
if [ -z "${PORT:-}" ]; then
  PORT="$("$NODE_BIN" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')" \
    || fail "无法选择空闲端口"
fi
for reserved in $RESERVED_PORTS; do
  [ "$PORT" = "$reserved" ] && fail "端口 $PORT 是保留端口，请换一个"
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "端口 $PORT 已被占用"
fi

echo "沙箱 DSH_HOME: $HOME_DIR"
echo "沙箱端口:      $PORT"
echo "插件目录:      $HERE"

# --- 1. isolated profile ----------------------------------------------------
step "1/6 从 web 模板创建隔离 profile"
if [ -f "$HOME_DIR/profiles/$PROFILE/package.json" ]; then
  ok "复用已存在的沙箱 profile（${PROFILE}）"
else
  DSH_RUN "$PROFILE" --from-default-profile web --dump-config >"$LOG_DIR/profile.txt" 2>&1 \
    || { tail -20 "$LOG_DIR/profile.txt" >&2; fail "无法从 web 模板创建隔离 profile"; }
  ok "隔离 profile 已创建（${PROFILE}）"
fi

# --- 2. credentials ---------------------------------------------------------
# The scratch turns are real model calls, so the sandbox needs the deployment's
# credentials. Only the credential file is copied; nothing else leaves ~/.dsh.
step "2/6 把凭据复制进沙箱（真实模型调用所需）"
if [ -f "$HOME/.dsh/.credentials.yaml" ]; then
  cp "$HOME/.dsh/.credentials.yaml" "$HOME_DIR/.credentials.yaml"
  chmod 600 "$HOME_DIR/.credentials.yaml"
  ok "凭据已复制（沙箱内）"
else
  echo "· 没找到 ~/.dsh/.credentials.yaml，跳过（模型调用可能失败）"
fi

# --- 3. install -------------------------------------------------------------
step "3/6 安装本插件"
DSH_RUN plugin --profile "$PROFILE" add "$HERE" >"$LOG_DIR/install.txt" 2>&1 \
  || { tail -20 "$LOG_DIR/install.txt" >&2; fail "插件安装失败"; }
ok "插件已安装"

# --- 4. dev tools + boot ----------------------------------------------------
step "4/6 打开 dev 路由并启动沙箱实例（不会碰 3080）"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf -- "# Sandbox patch layer.\n" > "$PATCH"
fi
if ! grep -q "devTools: true" "$PATCH"; then
  if [ "$(sed 's/#.*//' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
    # An empty patch is a bare `[]`; replace it wholesale instead of appending
    # a second YAML document.
    cat > "$PATCH" <<'EOF'
# Sandbox patch layer.
- id: dsh-rerun-turn
  config:
    devTools: true
EOF
  else
    cat >> "$PATCH" <<'EOF'

- id: dsh-rerun-turn
  config:
    devTools: true
EOF
  fi
fi
DSH_RUN --profile "$PROFILE" --port "$PORT" >"$LOG_DIR/boot.log" 2>&1 &
PID=$!
STATUS="died"
for _ in $(seq 1 45); do
  sleep 2
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then STATUS="up"; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
done
if [ "$STATUS" != "up" ]; then
  echo "--- 启动日志 ---" >&2
  tail -30 "$LOG_DIR/boot.log" >&2
  fail "profile 启动失败"
fi
ok "沙箱实例已启动（HTTP 401 = 需要 token，属预期）"
if grep -qE "failed to import|unsupported JSON schema|failed to apply loader entry dsh-rerun-turn" "$LOG_DIR/boot.log"; then
  echo "--- 启动日志 ---" >&2
  grep -E "failed to import|unsupported JSON schema|failed to apply" "$LOG_DIR/boot.log" >&2
  fail "插件加载/注册失败"
fi

# --- 5. routes + end-to-end -------------------------------------------------
step "5/6 宿主路由与端到端重跑"
BASE="http://127.0.0.1:$PORT"
UNKNOWN="session-00000000-0000-4000-8000-00000000ffff"
ROUTE_READY=0
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE$ROUTE/state?sessionId=$UNKNOWN" 2>/dev/null)"
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then ROUTE_READY=1; break; fi
  sleep 1
done
[ "$ROUTE_READY" = "1" ] || fail "插件路由在 20 秒内没有就绪"

expect() {
  local label="$1" want="$2"
  shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$@" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    ok "${label} -> ${got}"
  else
    fail "${label}: expected ${want}, got ${got:-(no response)}"
  fi
}

expect "GET $ROUTE/state 缺 sessionId"        400 "$BASE$ROUTE/state"
expect "GET $ROUTE/state 会话不存在"          404 "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "POST $ROUTE/apply 方法错误(GET)"      405 "$BASE$ROUTE/apply"
expect "POST $ROUTE/apply 坏 JSON"            400 -X POST -H 'content-type: application/json' --data '{nope' "$BASE$ROUTE/apply"
expect "跨源 Origin 被拒"                     403 -H "Origin: http://evil.test" "$BASE$ROUTE/state?sessionId=$UNKNOWN"
expect "伪造 Host 被拒"                       403 -H "Host: evil.test" "$BASE$ROUTE/state?sessionId=$UNKNOWN"
ok "宿主半部已挂载并走通自己的守卫"

echo
echo "── 端到端：创建 3 轮 scratch 会话 → 重跑第 2 轮 → 追加一轮 → 读实时派生上下文"
PORT="$PORT" "$NODE_BIN" "$HERE/tools/verify-live-e2e.mjs" "$PORT" \
  || fail "端到端重跑验证失败（见上方输出）"

echo
echo "── 严格冷读校验：用官方加载路径重读沙箱写出的会话日志"
VALIDATE="$("$NODE_BIN" "$HERE/tools/repair-session.mjs" "$HOME_DIR/sessions" --dry-run 2>&1)" \
  || fail "修复/校验工具执行失败"
echo "$VALIDATE" | tail -3
if ! echo "$VALIDATE" | grep -q "0 broken"; then
  echo "$VALIDATE" >&2
  fail "沙箱存在无法冷读的会话日志（上表 BROKEN 行）"
fi
ok "沙箱写出的日志全部通过严格冷读（含重跑标记的会话）"

# --- 6. teardown ------------------------------------------------------------
step "6/6 清理"
stop_sandbox
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "端口 $PORT 上仍有监听进程"
fi
ok "沙箱实例已停止（按 pid 收尾 + 端口 $PORT 已无监听）"

echo
echo "dsh-rerun-turn 已在真实 DSH 沙箱中通过端到端验证。"
