// VLAN Read-Only Wallet — served EIP-1193 provider announced via EIP-6963.
// No bundler: this re-implements Task 3's handler.ts classify rule in plain
// browser JS by fetching /wallet/read-methods.json at load. Reject-by-default:
// a method is forwarded ONLY if it is in the awaited read set; everything else
// (all signing methods, all unknown methods) throws { code: 4200, ... }.
(function () {
  "use strict";

  var CHAIN_ID_HEX = "0xaa36a7"; // Sepolia
  var NET_VERSION = "11155111";

  // --- Read-methods fetch race: kick off ONCE, store the PROMISE. request()
  // awaits this before classifying so an early caller is not mis-rejected. ---
  var readyPromise = fetch("/wallet/read-methods.json")
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      return new Set(j.read);
    });

  // classify: mirror handler.ts — in read set => "read", else "reject".
  function classify(readSet, method) {
    return readSet.has(method) ? "read" : "reject";
  }

  function reject4200(method) {
    throw { code: 4200, message: "read-only wallet: " + method + " not permitted" };
  }

  // --- EIP-1193 event support ---
  var listeners = Object.create(null);
  function on(event, handler) {
    (listeners[event] || (listeners[event] = [])).push(handler);
    return provider;
  }
  function removeListener(event, handler) {
    var arr = listeners[event];
    if (!arr) return provider;
    listeners[event] = arr.filter(function (h) {
      return h !== handler;
    });
    return provider;
  }
  function emit(event, payload) {
    var arr = listeners[event];
    if (!arr) return;
    arr.slice().forEach(function (h) {
      try {
        h(payload);
      } catch (e) {
        /* swallow listener errors */
      }
    });
  }

  var connectEmitted = false;

  // eth_accounts / eth_requestAccounts — never fabricate an address.
  function fetchAccounts() {
    return fetch("/api/wallet/account")
      .then(function (r) {
        if (!r.ok) return [];
        return r.json().then(function (j) {
          return [j.address];
        });
      })
      .then(function (accounts) {
        if (accounts.length > 0) {
          if (!connectEmitted) {
            connectEmitted = true;
            emit("connect", { chainId: CHAIN_ID_HEX });
          }
          emit("accountsChanged", [accounts[0]]);
        }
        return accounts;
      })
      .catch(function () {
        return [];
      });
  }

  function request(args) {
    args = args || {};
    var method = args.method;
    var params = args.params;

    // Answered immediately, no await needed.
    if (method === "eth_chainId") return Promise.resolve(CHAIN_ID_HEX);
    if (method === "net_version") return Promise.resolve(NET_VERSION);

    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return fetchAccounts();
    }

    // Every classified method must await the read set before deciding.
    return readyPromise.then(function (readSet) {
      if (classify(readSet, method) === "read") {
        return fetch("/api/wallet/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: method, params: params }),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (j && j.error) throw j.error;
            return j.result;
          });
      }
      return reject4200(method);
    });
  }

  var provider = {
    isVLANReadOnly: true,
    request: request,
    on: on,
    removeListener: removeListener,
  };

  // --- EIP-6963 announce. uuid is the hardcoded literal (NEVER randomUUID) so
  // dedupe holds across re-announces. ---
  var info = {
    uuid: "8f3d1c60-2a4e-4b7a-9e11-6c0f2d5a7b31",
    name: "VLAN Read-Only Wallet",
    icon:
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
          '<rect width="96" height="96" rx="18" fill="#111"/>' +
          '<circle cx="48" cy="48" r="26" fill="none" stroke="#5eead4" stroke-width="6"/>' +
          '<circle cx="48" cy="48" r="7" fill="#5eead4"/>' +
          "</svg>"
      ),
    rdns: "eth.ethglobal2.readonly",
  };

  function announce() {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info: info, provider: provider }),
      })
    );
  }

  // Announce-vs-requestProvider race: announce at load AND re-announce on any
  // requestProvider, so a dapp that dispatched requestProvider before this
  // script loaded still discovers the wallet.
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
