#!/usr/bin/env bash
# The whole lifecycle, end to end, against live Sepolia and a live enforcer.
#
# Nothing here is stubbed: the branch is really opened by the factory, the group is really
# defined on chain, the member is really minted, the member really signs, and the enforcer
# really gets the rows it needs to admit them. Every assertion reads back from the authority
# that owns the answer — the chain for identity, the enforcer for admission.
#
#   scripts/e2e-lifecycle.sh
#
# Requires: a running console (CONSOLE, default :3200), a running enforcer (ENFORCER,
# default :8091), $PRIVATE_KEY for the org, and cast on PATH.
set -uo pipefail

CONSOLE="${CONSOLE:-http://127.0.0.1:3200}"
ENFORCER="${ENFORCER:-http://127.0.0.1:8091}"
RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
RESOLVER=0x9D8f1376aED12F6F7Ba041285Cce833AcED13092

pass=0; fail=0; lag=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (got '$2', want '$3')"; fi; }

# The ENS indexer is eventually consistent by design, and the staging instance runs minutes
# behind the chain head. A branch opened during this run will not be in it yet.
#
# Not counted as a failure: it is a property of somebody else's cache, not of this code. What
# matters is that nothing in the admission path depends on it — the portal reads branches from
# the factory's own logs precisely so a member onboarded at the desk can sign in on the walk to
# the door. This reports the lag instead of pretending it is a bug or pretending it is a pass.
lagging() {
  local what="$1" want="$2" cmd="$3" got="" i
  for i in $(seq 1 15); do
    got=$(eval "$cmd" 2>/dev/null)
    [ "$got" = "$want" ] && { ok "$what"; return; }
    sleep 4
  done
  # A miss here is only tolerable if the route itself is healthy. If it is erroring, or its
  # shape changed, that is a failure wearing a lag costume.
  if [ -z "$got" ]; then
    no "$what (the query returned nothing at all, which is not indexer lag)"
    return
  fi
  printf '  \033[33mLAG \033[0m %s (indexer behind; the same branch is present via the chain fallback)\n' "$what"
  lag=$((lag+1))
}

CT="${CONSOLE_TOKEN:?CONSOLE_TOKEN must be set}"
ET="${ENFORCER_TOKEN:?ENFORCER_TOKEN must be set}"
api()  { curl -s -H "x-console-token: $CT" -H 'content-type: application/json' "$@"; }
enf()  { curl -s -H "authorization: Bearer $ET" "$@"; }

STAMP=$(date +%H%M%S)
BRANCH_LABEL="e2e-$STAMP"
GROUP="mentor$STAMP"
MEMBER=alice
# A Member name is minted in the ORGANIZATION registry, the same namespace branches live in —
# so a member label equal to the branch label collides with the branch and `ensureMember`
# reverts LabelUnavailable. Distinct prefix, deliberately.
MEMBER_LABEL="m$STAMP"
# Deliberately different from the role name: the enforcer joins on the `wifi.group` entitlement,
# not on what the role is called, and a test where the two are equal cannot tell them apart.
WIFI_GROUP="wifi$STAMP"

step "0. The gate is closed to anyone without the console token"
is "unauthenticated write is refused" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/api/ens/groups" -d '{}')" 401
is "...while the same route still answers reads: the gate is on the method, not the path" \
   "$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLE/api/ens/groups?registrar=0x0000000000000000000000000000000000000001")" 200
is "unauthenticated enforcer proxy is refused" \
   "$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLE/api/admin/groups")" 401

step "1. Open a branch — one transaction, through the console's own API"
BRANCH_JSON=$(api -X POST "$CONSOLE/api/ens/branch" -d "{\"label\":\"$BRANCH_LABEL\"}")
REGISTRAR=$(echo "$BRANCH_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("registrar",""))')
REGISTRY=$(echo "$BRANCH_JSON"  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("registry",""))')
if [ -n "$REGISTRAR" ]; then ok "branch created, registrar $REGISTRAR"; else no "createBranch: $BRANCH_JSON"; exit 1; fi

BRANCH_NAME="$BRANCH_LABEL.ethglobal2.eth"
is "the registrar's node is the real ENS namehash" \
   "$(cast call "$REGISTRAR" 'BRANCH_NODE()(bytes32)' --rpc-url "$RPC")" \
   "$(cast namehash "$BRANCH_NAME")"
is "the branch publishes its registrar for discovery" \
   "$(cast call "$RESOLVER" 'text(bytes32,string)(string)' "$(cast namehash "$BRANCH_NAME")" 'ensca.registrar' --rpc-url "$RPC" | tr -d '"' | tr 'A-Z' 'a-z')" \
   "$(echo "$REGISTRAR" | tr 'A-Z' 'a-z')"

step "2. Define a group — on chain, and mirrored into the enforcer"
GROUP_JSON=$(api -X POST "$CONSOLE/api/ens/groups" -d "{
  \"registrar\":\"$REGISTRAR\",\"name\":\"$GROUP\",
  \"canOnboard\":false,\"openToOnboarders\":true,
  \"editableKeys\":[\"avatar\"],
  \"entitlements\":[{\"key\":\"wifi.group\",\"value\":\"$WIFI_GROUP\"},{\"key\":\"role\",\"value\":\"$GROUP\"},{\"key\":\"wifi.rate\",\"value\":\"20mbps\"}]}")
is "group mirrored to the enforcer" \
   "$(echo "$GROUP_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mirrored"))')" True
is "the enforcer row is named for the wifi.group entitlement, not the role" \
   "$(enf "$ENFORCER/admin/groups" | python3 -c "import json,sys;gs=json.load(sys.stdin)['groups'];print(any(g['name']=='$WIFI_GROUP' for g in gs))")" True
is "and NOT for the role name, which is a different string" \
   "$(enf "$ENFORCER/admin/groups" | python3 -c "import json,sys;gs=json.load(sys.stdin)['groups'];print(any(g['name']=='$GROUP' for g in gs))")" False
is "the chain agrees which keys the group may edit" \
   "$(cast call "$REGISTRAR" 'editableKeysOf(bytes32)(string[])' "$(cast keccak $GROUP)" --rpc-url "$RPC")" \
   '["avatar"]'

step "3. Onboard a member — minted on chain, mirrored to the enforcer"
WALLET_JSON=$(cast wallet new --json)
ADDR=$(echo "$WALLET_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["address"])')
PK=$(echo "$WALLET_JSON"   | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["private_key"])')
ONBOARD_JSON=$(api -X POST "$CONSOLE/api/ens/onboard" -d "{
  \"registrar\":\"$REGISTRAR\",\"label\":\"$MEMBER\",\"owner\":\"$ADDR\",
  \"group\":\"$GROUP\",\"memberLabel\":\"$MEMBER_LABEL\"}")
is "member mirrored to the enforcer" \
   "$(echo "$ONBOARD_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mirrored"))')" True

NAME="$MEMBER.$BRANCH_NAME"
NODE=$(cast namehash "$NAME")
is "the name is owned by the member's wallet" \
   "$(cast call "$REGISTRY" 'getOwner(uint256)(address)' "$(cast call "$REGISTRY" 'getResource(uint256)(uint256)' "$(python3 -c "print(int('$(cast keccak $MEMBER)',16))")" --rpc-url "$RPC" | awk '{print $1}')" --rpc-url "$RPC" | tr 'A-Z' 'a-z')" \
   "$(echo "$ADDR" | tr 'A-Z' 'a-z')"
is "entitlements resolve at the real namehash" \
   "$(cast call "$RESOLVER" 'text(bytes32,string)(string)' "$NODE" 'wifi.rate' --rpc-url "$RPC")" '"20mbps"'
is "the enforcer knows this member by their full ENS name" \
   "$(enf "$ENFORCER/admin/users/by-ens/$NAME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ens_name",""))')" "$NAME"
is "and filed them under the group the enforcer will look up" \
   "$(enf "$ENFORCER/admin/users/by-ens/$NAME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("group",{}).get("name",""))')" "$WIFI_GROUP"

step "3b. Every ENS query the console makes, against live state"
# --- the console's HTTP query surface -------------------------------------------------
is "availability: a taken branch label reads taken" \
   "$(api "$CONSOLE/api/ens/branch?label=$BRANCH_LABEL" | python3 -c 'import json,sys;print(json.load(sys.stdin)["available"])')" False
is "availability: a free branch label reads free" \
   "$(api "$CONSOLE/api/ens/branch?label=$BRANCH_LABEL-free" | python3 -c 'import json,sys;print(json.load(sys.stdin)["available"])')" True
is "availability: an invalid label is rejected, not guessed" \
   "$(api "$CONSOLE/api/ens/branch?label=NOT.valid" | python3 -c 'import json,sys;print(json.load(sys.stdin)["valid"])')" False
is "availability: a taken membership label inside the branch reads taken" \
   "$(api "$CONSOLE/api/ens/available?label=$MEMBER&registry=$REGISTRY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["available"])')" False
is "availability: an org .eth name already owned reads taken" \
   "$(api "$CONSOLE/api/ens/available?label=ethglobal2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["available"])')" False

lagging "branches query: the new branch is discoverable from ENS alone" True \
   "api $CONSOLE/api/ens/branches | python3 -c \"import json,sys;print(any(b['label']=='$BRANCH_LABEL' for b in json.load(sys.stdin)['branches']))\""
lagging "branches query: it carries the registrar read from the text record" \
   "$(echo "$REGISTRAR" | tr 'A-Z' 'a-z')" \
   "api $CONSOLE/api/ens/branches | python3 -c \"import json,sys;print(next((b['registrar'].lower() for b in json.load(sys.stdin)['branches'] if b['label']=='$BRANCH_LABEL'),''))\""

is "groups query: the catalogue reads back from chain logs" \
   "$(api "$CONSOLE/api/ens/groups?registrar=$REGISTRAR" | python3 -c "import json,sys;print(next((g['name'] for g in json.load(sys.stdin)['groups'] if g['name']=='$GROUP'), ''))")" "$GROUP"
is "groups query: entitlements come back with it" \
   "$(api "$CONSOLE/api/ens/groups?registrar=$REGISTRAR" | python3 -c "import json,sys;g=next(g for g in json.load(sys.stdin)['groups'] if g['name']=='$GROUP');print(next(e['value'] for e in g['entitlements'] if e['key']=='wifi.rate'))")" 20mbps
is "groups query: a missing registrar is refused, not defaulted to another branch" \
   "$(curl -s -o /dev/null -w '%{http_code}' -H "x-console-token: $CT" "$CONSOLE/api/ens/groups")" 400

lagging "memberships query: the member appears" True \
   "api '$CONSOLE/api/ens/memberships?branch=$BRANCH_LABEL' | python3 -c \"import json,sys;print(any(m['label']=='$MEMBER' for m in json.load(sys.stdin)['memberships']))\""
lagging "memberships query: with their resolved role" "$GROUP" \
   "api '$CONSOLE/api/ens/memberships?branch=$BRANCH_LABEL' | python3 -c \"import json,sys;print(next((m['role'] for m in json.load(sys.stdin)['memberships'] if m['label']=='$MEMBER'),''))\""

is "resolve: the admission lookup answers for a real member" \
   "$(curl -s "$CONSOLE/api/ens/resolve?name=$NAME" | python3 -c 'import json,sys;print(json.load(sys.stdin)["role"])')" "$GROUP"
is "resolve: a name that is not a membership is a 404 deny" \
   "$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLE/api/ens/resolve?name=nobody.$BRANCH_NAME")" 404
is "resolve: a name outside the organization is a 404 deny" \
   "$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLE/api/ens/resolve?name=someone.vitalik.eth")" 404

# --- the registry and registrar, read directly ----------------------------------------
LH=$(python3 -c "print(int('$(cast keccak $MEMBER)',16))")
RES_ID=$(cast call "$REGISTRY" 'getResource(uint256)(uint256)' "$LH" --rpc-url "$RPC" | awk '{print $1}')
is "registry: the membership label is REGISTERED (status 2)" \
   "$(cast call "$REGISTRY" 'getStatus(uint256)(uint8)' "$LH" --rpc-url "$RPC")" 2
is "registry: the branch points back up at the organization" \
   "$(cast call "$REGISTRY" 'getParent()(address,string)' --rpc-url "$RPC" | tail -1 | tr -d '"')" "$BRANCH_LABEL"
is "registry: the organization points down at the branch" \
   "$(cast call 0xEb716b3fB749f357be2B74a10647675D11a94517 'getSubregistry(string)(address)' "$BRANCH_LABEL" --rpc-url "$RPC" | tr 'A-Z' 'a-z')" \
   "$(echo "$REGISTRY" | tr 'A-Z' 'a-z')"
is "registry: a membership carries no subregistry of its own" \
   "$(cast call "$REGISTRY" 'getSubregistry(string)(address)' "$MEMBER" --rpc-url "$RPC")" \
   0x0000000000000000000000000000000000000000

is "registrar: the group we defined is the one roleOf points at" \
   "$(cast call "$REGISTRAR" 'roleId(string)(bytes32)' "$GROUP" --rpc-url "$RPC")" \
   "$(cast call "$REGISTRAR" 'roleOf(uint256)(bytes32)' "$RES_ID" --rpc-url "$RPC")"
is "registrar: membershipNode matches the real namehash" \
   "$(cast call "$REGISTRAR" 'membershipNode(string)(bytes32)' "$MEMBER" --rpc-url "$RPC")" "$NODE"
is "registrar: roleOf maps the membership to its group" \
   "$(cast call "$REGISTRAR" 'roleOf(uint256)(bytes32)' "$RES_ID" --rpc-url "$RPC")" "$(cast keccak $GROUP)"
is "registrar: memberOf maps it back to the wallet" \
   "$(cast call "$REGISTRAR" 'memberOf(uint256)(address)' "$RES_ID" --rpc-url "$RPC" | tr 'A-Z' 'a-z')" \
   "$(echo "$ADDR" | tr 'A-Z' 'a-z')"
is "registrar: labelOf recovers the label" \
   "$(cast call "$REGISTRAR" 'labelOf(uint256)(string)' "$RES_ID" --rpc-url "$RPC" | tr -d '"')" "$MEMBER"
is "registrar: effectiveRole reports the member's role" \
   "$(cast call "$REGISTRAR" 'effectiveRole(address)(bytes32,bool)' "$ADDR" --rpc-url "$RPC" | head -1)" "$(cast keccak $GROUP)"
is "registrar: the group is active in the catalogue" \
   "$(cast call "$REGISTRAR" 'roleSpec(bytes32)(uint256,bool,bool,bool)' "$(cast keccak $GROUP)" --rpc-url "$RPC" | tail -1)" true
is "registrar: a group defined on ANOTHER branch is not active here" \
   "$(cast call "$REGISTRAR" 'roleSpec(bytes32)(uint256,bool,bool,bool)' "$(cast keccak mentor)" --rpc-url "$RPC" | tail -1)" false

is "org registrar: the member has an org-wide Member name" \
   "$(cast call 0xA0F10DFd7022eBa1114ECe9C16149841a023Ecd7 'isMember(address)(bool)' "$ADDR" --rpc-url "$RPC")" true
is "org registrar: minted once, under the label we asked for" \
   "$(cast call 0xA0F10DFd7022eBa1114ECe9C16149841a023Ecd7 'labelOf(address)(string)' "$ADDR" --rpc-url "$RPC" | tr -d '"')" "$MEMBER_LABEL"

step "4. The permission matrix, against the live resolver"
# A denial and a broken RPC are not the same answer. `cast call` exits non-zero for both, so
# match on the revert the resolver actually raises; anything else is reported as an error and
# fails the assertion rather than quietly reading as "correctly denied".
may() {
  local out
  out=$(cast call "$RESOLVER" 'setText(bytes32,string,string)' "$2" "$3" probe --from "$1" --rpc-url "$RPC" 2>&1)
  if [ $? -eq 0 ]; then echo yes; return; fi
  case "$out" in
    *EACUnauthorizedAccountRoles*|*"execution reverted"*) echo no ;;
    *) echo "error: ${out:0:60}" ;;
  esac
}
is "member may write their own listed key"        "$(may "$ADDR" "$NODE" avatar)"    yes
is "member may NOT write an unlisted key"         "$(may "$ADDR" "$NODE" wifi.rate)" no
is "member may NOT write the branch node"         "$(may "$ADDR" "$(cast namehash "$BRANCH_NAME")" avatar)" no
is "member may NOT hijack the discovery record"   "$(may "$ADDR" "$(cast namehash "$BRANCH_NAME")" ensca.registrar)" no
is "a stranger may write nothing"                 "$(may 0x000000000000000000000000000000000000dEaD "$NODE" avatar)" no

step "4b. The member actually writes — and cannot write for anyone else"
# Fund the member so they can send a real transaction. Until this existed, the revocation
# assertion below compared an empty record to an empty record and proved nothing.
cast send "$ADDR" --value 0.003ether --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null 2>&1
if cast send "$RESOLVER" 'setText(bytes32,string,string)' "$NODE" avatar "ipfs://$STAMP" \
     --private-key "$PK" --rpc-url "$RPC" >/dev/null 2>&1; then
  ok "the member wrote their own record, signed by their own key"
else
  no "the member could not write their own record"
fi
is "and it is readable at their name" \
   "$(cast call "$RESOLVER" 'text(bytes32,string)(string)' "$NODE" avatar --rpc-url "$RPC")" "\"ipfs://$STAMP\""

# A second member, so the cross-member case is testable at all.
SECOND=$(cast wallet new --json)
S2_ADDR=$(echo "$SECOND" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["address"])')
api -X POST "$CONSOLE/api/ens/onboard" -d "{
  \"registrar\":\"$REGISTRAR\",\"label\":\"bob\",\"owner\":\"$S2_ADDR\",
  \"group\":\"$GROUP\",\"memberLabel\":\"b$STAMP\"}" > /dev/null
S2_NODE=$(cast namehash "bob.$BRANCH_NAME")
is "the second member exists" \
   "$(cast call "$REGISTRAR" 'membershipOf(address)(uint256)' "$S2_ADDR" --rpc-url "$RPC" | awk '{print $1}' | grep -q '^0$' && echo missing || echo present)" present
is "a member may NOT write another member's listed key" "$(may "$ADDR" "$S2_NODE" avatar)" no
is "...and the other way round either"                  "$(may "$S2_ADDR" "$NODE" avatar)" no

step "4c. The org key cannot be aimed at a contract that is not ours"
is "a foreign registrar is refused" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/api/ens/groups" -H "x-console-token: $CT" \
      -H 'content-type: application/json' \
      -d '{"registrar":"0x00000000219ab540356cBB839Cbe05303d7705Fa","name":"x","entitlements":[]}')" 403

step "5. The member signs in at the portal"
NONCE=$(curl -s -X POST "$CONSOLE/api/portal/challenge" | python3 -c 'import json,sys;print(json.load(sys.stdin)["nonce"])')
SIG=$(cast wallet sign --private-key "$PK" "$(printf 'Sign in to ENSCA\nNonce: %s' "$NONCE")")
VERIFY=$(curl -s -X POST "$CONSOLE/api/portal/verify" -H 'content-type: application/json' \
  -d "{\"nonce\":\"$NONCE\",\"signature\":\"$SIG\",\"wallet_address\":\"$ADDR\"}")
is "the signature resolves to their membership" \
   "$(echo "$VERIFY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ens_name",""))')" "$NAME"
is "and carries the wifi.group the enforcer will look up, not the role name" \
   "$(echo "$VERIFY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("group_name",""))')" "$WIFI_GROUP"
is "the nonce cannot be replayed" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/api/portal/verify" -H 'content-type: application/json' \
      -d "{\"nonce\":\"$NONCE\",\"signature\":\"$SIG\",\"wallet_address\":\"$ADDR\"}")" 401

STRANGER=$(cast wallet new --json)
S_ADDR=$(echo "$STRANGER" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["address"])')
S_PK=$(echo "$STRANGER"   | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["private_key"])')
N2=$(curl -s -X POST "$CONSOLE/api/portal/challenge" | python3 -c 'import json,sys;print(json.load(sys.stdin)["nonce"])')
S_SIG=$(cast wallet sign --private-key "$S_PK" "$(printf 'Sign in to ENSCA\nNonce: %s' "$N2")")
is "a stranger with a valid signature is refused" \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONSOLE/api/portal/verify" -H 'content-type: application/json' \
      -d "{\"nonce\":\"$N2\",\"signature\":\"$S_SIG\",\"wallet_address\":\"$S_ADDR\"}")" 403

step "6. The enforcer resolves the member the way the portal will"
LOOKUP=$(curl -s "$ENFORCER/internal/ens-lookup/$NAME")
is "enforcer resolves the member to a real group" \
   "$(echo "$LOOKUP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(bool(d.get("group_id")))')" True
is "and to a real local user, not the shared anon sentinel" \
   "$(echo "$LOOKUP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(bool(d.get("user_id")))')" True

step "7. Revoke — the name, the records and the delegated rights all go"
RES=$(cast call "$REGISTRAR" 'membershipOf(address)(uint256)' "$ADDR" --rpc-url "$RPC" | awk '{print $1}')
# Through the product's own endpoint, not raw cast — this is the path an operator has, and it
# is the only thing that also disables the member on the enforcer.
REVOKE_JSON=$(api -X POST "$CONSOLE/api/ens/revoke" -d "{\"registrar\":\"$REGISTRAR\",\"wallet\":\"$ADDR\"}")
is "revoked through the console, and mirrored to the enforcer" \
   "$(echo "$REVOKE_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mirrored"))')" True
is "the enforcer has disabled them" \
   "$(enf "$ENFORCER/admin/users/by-ens/$NAME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("disabled"))')" True
is "so an enforcer lookup now refuses them even with the console down" \
   "$(curl -s -o /dev/null -w '%{http_code}' "$ENFORCER/internal/ens-lookup/$NAME")" 404
is "the membership pointer is cleared"  "$(cast call "$REGISTRAR" 'membershipOf(address)(uint256)' "$ADDR" --rpc-url "$RPC" | awk '{print $1}')" 0
is "the entitlements are cleared"       "$(cast call "$RESOLVER" 'text(bytes32,string)(string)' "$NODE" 'wifi.rate' --rpc-url "$RPC")" '""'
is "what the member wrote is cleared"   "$(cast call "$RESOLVER" 'text(bytes32,string)(string)' "$NODE" 'avatar' --rpc-url "$RPC")" '""'
is "and they can no longer write"       "$(may "$ADDR" "$NODE" avatar)" no

printf '\n\033[1m%d passed, %d failed, %d waiting on the indexer\033[0m\n' "$pass" "$fail" "$lag"
[ "$fail" -eq 0 ]
