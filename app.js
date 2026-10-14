/*
  W&L Athletics Van and MiFi Reservations
  Front end for GitHub Pages. Data lives in the Van Checkout 2026-27 Google Sheet,
  reached through a Google Apps Script web app (Code.gs). Sign-in uses W&L Microsoft 365.

  Layout: Vans and MiFi hotspots tabs; Table, Cards, or Calendar view;
  a one-step-at-a-time booking form; "Modify or Cancel Reservation" for bookings.
  A van and MiFi booked together are one reservation and always change or cancel together.
*/
(function () {
  "use strict";

  const CFG = window.VAN_CONFIG || {};
  const VANS = CFG.vans || [];
  const MIFIS = CFG.mifis || [];
  const AUTH = CFG.auth || {};
  const AUTH_ON = !!AUTH.clientId;
  const DEMO = !CFG.apiUrl;
  const DOMAIN = (CFG.emailDomain || "").toLowerCase();

  const DEMO_KEY = "wlu-van-demo-v3";
  const PREFS_KEY = "wlu-van-prefs-v1";
  const DISPLAY_KEY = "wlu-van-display-v1";
  const PENDING_KEY = "wlu-van-pending-v1";
  const REFRESH_MS = 60000;
  const STEP_NAMES = ["Dates", "What you need", "Your details", "Review"];
  const SYM = { ok: "&#10003;", busy: "&#10007;", done: "&#9670;", late: "&#9650;" };

  const state = {
    reservations: [],
    tab: "vans",
    view: "table",
    listFrom: todayISO(),
    listTo: todayISO(),
    month: todayISO().slice(0, 8) + "01",
    selectedDay: todayISO(),
    mine: [],
    mineAdmin: false,
    loadPromise: null
  };
  let wiz = null;      // the booking form in progress
  let msalApp = null;
  let account = null;
  let demoMemory = null;

  /* ================= Helpers ================= */

  function $(sel) { return document.querySelector(sel); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function toISO(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromISO(s) { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function todayISO() { return toISO(new Date()); }
  function addDays(s, n) { const d = fromISO(s); d.setDate(d.getDate() + n); return toISO(d); }
  function addMonths(s, n) { const d = fromISO(s); d.setDate(1); d.setMonth(d.getMonth() + n); return toISO(d); }
  function fmt(s, opts) { return fromISO(s).toLocaleDateString("en-US", opts); }
  function fmtDay(s) { return fmt(s, { weekday: "short", month: "short", day: "numeric" }); }
  function fmtLong(s) { return fmt(s, { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
  function fmtRange(a, b) {
    if (a === b) return fmt(a, { month: "short", day: "numeric", year: "numeric" });
    const sameYear = a.slice(0, 4) === b.slice(0, 4);
    return fmt(a, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }) +
      " to " + fmt(b, { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtStamp(s) {
    if (!s) return "";
    const parts = s.split(" ");
    let out = fmt(parts[0], { month: "short", day: "numeric" });
    if (parts[1]) {
      const hm = parts[1].split(":").map(Number);
      out += ", " + ((hm[0] % 12) || 12) + ":" + pad(hm[1]) + (hm[0] < 12 ? " AM" : " PM");
    }
    return out;
  }
  function dayCount(a, b) { return Math.round((fromISO(b) - fromISO(a)) / 86400000) + 1; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function vanName(id) { const v = VANS.find(function (x) { return x.id === id; }); return v ? v.name : "Van " + id; }
  function mifiName(id) { const m = MIFIS.find(function (x) { return x.id === id; }); return m ? m.name : "MiFi " + id; }
  function itemName(kind, id) { return kind === "van" ? vanName(id) : mifiName(id); }
  // "Van 208 + MiFi 3", "Van 208", or "MiFi 3"
  function itemLabel(r) {
    return [r.van ? vanName(r.van) : "", r.mifi ? mifiName(r.mifi) : ""].filter(Boolean).join(" + ");
  }
  // Words for buttons: "van and MiFi", "van", or "MiFi"
  function bundleWords(r) { return r.van && r.mifi ? "van and MiFi" : (r.van ? "van" : "MiFi"); }

  function storageGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function storageDel(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 8000);
  }
  function setStatus(msg) { $("#status").textContent = msg; }

  /* ================= Reservation status ================= */

  function isReturned(r) { return r.status === "Returned" && !!r.returnedAt; }
  // Flag a missing return for two weeks after the last day (older history is not flagged)
  function isOverdue(r) { const t = todayISO(); return !isReturned(r) && r.endDate < t && r.endDate >= addDays(t, -14); }
  // Last day a reservation blocks its items. An early return frees the remaining days.
  function blockEnd(r) {
    if (isReturned(r)) {
      const rd = r.returnedAt.slice(0, 10);
      if (rd < r.endDate) return rd < r.startDate ? r.startDate : rd;
    }
    return r.endDate;
  }
  // Reservations holding this van or MiFi for any day in start..end
  function overlapping(kind, id, start, end, ignoreId) {
    return state.reservations.filter(function (r) {
      return r[kind] === id && (!ignoreId || r.id !== ignoreId) && r.startDate <= end && blockEnd(r) >= start;
    });
  }
  function isFree(kind, id, start, end, ignoreId) { return overlapping(kind, id, start, end, ignoreId).length === 0; }
  function nextFreeDay(kind, id, date) {
    let d = date;
    for (let i = 0; i < 730; i++) { if (isFree(kind, id, d, d)) return d; d = addDays(d, 1); }
    return null;
  }
  function statusOf(r) {
    const t = todayISO();
    if (isReturned(r)) return { cls: "done", text: "Returned" };
    if (r.endDate < t) return { cls: "late", text: "Not returned" };
    if (r.startDate <= t) return { cls: "busy", text: "In use" };
    return { cls: "busy", text: "Reserved" };
  }
  function stTag(cls, text) { return '<span class="st ' + cls + '">' + SYM[cls] + " " + esc(text) + "</span>"; }
  function lastReturn(kind, id) {
    return state.reservations.filter(function (r) { return r[kind] === id && isReturned(r); })
      .sort(function (a, b) { return b.returnedAt.localeCompare(a.returnedAt); })[0];
  }
  function returnLine(r) {
    if (!r) return "";
    const bits = ["Last returned " + fmtStamp(r.returnedAt)];
    if (r.returnMileage) bits.push(r.returnMileage + " mi");
    if (r.fullTank) bits.push("full tank: " + r.fullTank);
    let html = '<span class="sub">' + esc(bits.join(", ")) + "</span>";
    if (r.issues && !/^(none|no|n\/a|na|-)\.?$/i.test(r.issues.trim())) {
      html += '<span class="sub issue">' + SYM.late + " Issue reported: " + esc(r.issues) + "</span>";
    }
    return html;
  }

  /* ================= Display options ================= */

  function loadDisplay() {
    const d = storageGet(DISPLAY_KEY) || {};
    if (d.dark === undefined) {
      try { d.dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { d.dark = false; }
    }
    if (d.rm === undefined) {
      try { d.rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { d.rm = false; }
    }
    return { size: d.size || 1, hc: !!d.hc, dark: !!d.dark, rm: !!d.rm };
  }
  function applyDisplay(d) {
    const html = document.documentElement;
    html.classList.remove("size-1", "size-2", "size-3");
    html.classList.add("size-" + d.size);
    html.classList.toggle("hc", d.hc);
    html.classList.toggle("dark", d.dark && !d.hc);
    html.classList.toggle("rm", d.rm);
    document.querySelectorAll("[data-size]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.dataset.size) === d.size)); });
    $("#contrastBtn").setAttribute("aria-pressed", String(d.hc));
    $("#contrastBtn").textContent = "High contrast: " + (d.hc ? "On" : "Off");
    $("#darkBtn").setAttribute("aria-pressed", String(d.dark));
    $("#darkBtn").textContent = "Dark mode: " + (d.dark ? "On" : "Off");
    $("#motionBtn").setAttribute("aria-pressed", String(d.rm));
    $("#motionBtn").textContent = "Reduce motion: " + (d.rm ? "On" : "Off");
  }
  function setDisplay(change) {
    const d = Object.assign(loadDisplay(), change);
    if (change.hc) d.dark = false;     // high contrast and dark mode are separate looks
    if (change.dark) d.hc = false;
    storageSet(DISPLAY_KEY, d);
    applyDisplay(d);
  }

  /* ================= W&L sign-in (Microsoft 365) ================= */

  function signedInEmail() { return account ? String(account.username || "").toLowerCase() : ""; }
  function redirectUri() { return AUTH.redirectUri || (location.origin + location.pathname); }

  async function initAuth() {
    if (!AUTH_ON) { renderAuth(); return; }
    if (!window.msal) { setStatus("The W&L sign-in service did not load. Refresh the page to try again."); return; }
    msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: AUTH.clientId,
        authority: "https://login.microsoftonline.com/" + (AUTH.tenantId || "organizations"),
        redirectUri: redirectUri()
      },
      cache: { cacheLocation: "localStorage" }
    });
    try {
      const result = await msalApp.handleRedirectPromise();
      if (result && result.account) account = result.account;
    } catch (e) {
      console.error(e);
      toast("Sign-in did not finish. Please try again.");
    }
    if (!account) {
      const all = msalApp.getAllAccounts();
      if (all.length) account = all[0];
    }
    if (account) msalApp.setActiveAccount(account);
    renderAuth();

    // Resume what the person started before signing in
    const pending = storageGet(PENDING_KEY);
    if (account && pending) {
      storageDel(PENDING_KEY);
      await load(true);
      if (pending.mine) openMine(); else openWizard(pending);
    }
  }
  function signIn(pending) {
    if (pending) storageSet(PENDING_KEY, pending);
    msalApp.loginRedirect({ scopes: ["User.Read"], prompt: "select_account" });
  }
  function signOut() { msalApp.logoutRedirect({ account: account, postLogoutRedirectUri: redirectUri() }); }
  // Token the Google Sheet uses to confirm who is booking (it asks Microsoft directly)
  async function getToken() {
    if (!AUTH_ON || !account) return null;
    const req = { scopes: ["User.Read"], account: account };
    try {
      return (await msalApp.acquireTokenSilent(req)).accessToken;
    } catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError) { msalApp.acquireTokenRedirect(req); }
      throw e;
    }
  }
  function renderAuth() {
    const area = $("#authArea");
    if (!AUTH_ON) { area.innerHTML = ""; return; }
    area.innerHTML = account
      ? "<span>Signed in as " + esc(account.name || account.username) + '</span><button type="button" class="btn" id="signOutBtn">Sign out</button>'
      : '<button type="button" class="btn" id="signInBtn">Sign in with W&amp;L</button>';
  }

  /* ================= Data ================= */

  function normalize(r) {
    function s(v) { return v == null ? "" : String(v).trim(); }
    return {
      id: s(r.id), van: s(r.van), mifi: s(r.mifi),
      startDate: s(r.startDate).slice(0, 10), endDate: s(r.endDate).slice(0, 10),
      team: s(r.team), driver: s(r.driver), destination: s(r.destination),
      notes: s(r.notes), email: s(r.email),
      status: s(r.status) || "Reserved",
      returnedAt: s(r.returnedAt), returnMileage: s(r.returnMileage), fullTank: s(r.fullTank), issues: s(r.issues)
    };
  }

  function demoSeed() {
    const t = todayISO();
    return [
      { id: "R0001", van: "206", startDate: addDays(t, -6), endDate: addDays(t, -5), team: "Volleyball", driver: "Sample Coach", destination: "Away match",
        status: "Returned", returnedAt: addDays(t, -5) + " 21:40", returnMileage: "48210", fullTank: "Yes", issues: "None" },
      { id: "R0002", van: "97", startDate: addDays(t, -3), endDate: addDays(t, -2), team: "Men's Soccer", driver: "Sample Coach", destination: "Away game", status: "Reserved" },
      { id: "R0003", van: "208", startDate: t, endDate: t, team: "Men's Tennis", driver: "Sample Coach", destination: "Recruiting", status: "Reserved" },
      { id: "R0004", van: "140", mifi: "3", startDate: addDays(t, 1), endDate: addDays(t, 3), team: "Field Hockey", driver: "Sample Coach", destination: "Away game", status: "Reserved" },
      { id: "R0005", van: "203", startDate: addDays(t, 5), endDate: addDays(t, 6), team: "Football", driver: "Sample Coach", destination: "Scouting", status: "Reserved" },
      { id: "R0006", van: "", mifi: "5", startDate: addDays(t, 2), endDate: addDays(t, 2), team: "Volleyball", driver: "Sample Coach", destination: "Recruiting (own car)", status: "Reserved" }
    ];
  }
  function demoLoad() {
    let rows = storageGet(DEMO_KEY);
    if (!Array.isArray(rows)) rows = demoMemory || demoSeed();
    demoMemory = rows;
    storageSet(DEMO_KEY, rows);
    return rows.slice();
  }
  function demoSave(rows) { demoMemory = rows; storageSet(DEMO_KEY, rows); }

  async function fetchReservations() {
    if (DEMO) return demoLoad().map(normalize).filter(function (r) { return r.status !== "Cancelled"; });
    const res = await fetch(CFG.apiUrl + "?action=list&t=" + Date.now());
    if (!res.ok) throw new Error("List request failed (" + res.status + ")");
    const data = await res.json();
    if (data.ok === false) throw new Error(data.message || "List request failed");
    return (data.reservations || []).map(normalize).filter(function (r) { return (r.van || r.mifi) && r.startDate && r.endDate; });
  }

  // Demo mode: same rules as the Google Sheet, saved only in this browser
  function demoApi(action, p) {
    const all = demoLoad();
    const t = todayISO();
    const clash = function (ignoreId) {
      return all.map(normalize).some(function (r) {
        const same = (p.van && r.van === p.van) || (p.mifi && r.mifi === p.mifi);
        return r.status !== "Cancelled" && same && r.id !== ignoreId && r.startDate <= p.endDate && blockEnd(r) >= p.startDate;
      });
    };
    if (action === "book") {
      if (clash(null)) return { ok: false, conflict: true };
      const id = "R" + String(all.length + 1).padStart(4, "0");
      all.push(Object.assign({}, p, { id: id, status: "Reserved" }));
      demoSave(all);
      return { ok: true, id: id };
    }
    if (action === "mine") {
      return { ok: true, reservations: all.filter(function (r) {
        return (r.status || "Reserved") === "Reserved" && r.endDate >= t && String(r.email || "").toLowerCase() === p.email;
      }) };
    }
    const r = all.find(function (x) { return x.id === p.id; });
    if (!r) return { ok: false, message: "That reservation was not found." };
    if (action === "cancel") { r.status = "Cancelled"; demoSave(all); return { ok: true, id: r.id }; }
    if (action === "update") {
      if (clash(r.id)) return { ok: false, conflict: true };
      ["van", "mifi", "startDate", "endDate", "team", "driver", "destination", "notes"].forEach(function (k) { r[k] = p[k]; });
      demoSave(all);
      return { ok: true, id: r.id };
    }
    return { ok: false, message: "Unknown request." };
  }

  // Sends book, update, cancel, or mine to the Google Sheet
  async function api(action, payload) {
    if (DEMO) return demoApi(action, payload);
    const body = Object.assign({ action: action, token: await getToken() }, payload);
    // text/plain keeps this a "simple" request, which Google Apps Script accepts from GitHub Pages
    const res = await fetch(CFG.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    return await res.json();
  }

  function load(quiet) {
    if (state.loadPromise) return state.loadPromise;
    if (!quiet) setStatus("Loading reservations...");
    state.loadPromise = fetchReservations()
      .then(function (rows) {
        rows.sort(function (a, b) { return a.startDate.localeCompare(b.startDate); });
        state.reservations = rows;
        setStatus("Last updated " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
        render();
      })
      .catch(function (e) {
        console.error(e);
        setStatus("Could not load reservations. Check your connection and refresh the page.");
      })
      .finally(function () { state.loadPromise = null; });
    return state.loadPromise;
  }

  /* ================= Main page ================= */

  function rangeText() {
    const n = dayCount(state.listFrom, state.listTo);
    return state.listFrom === state.listTo ? fmtDay(state.listFrom) : fmtRange(state.listFrom, state.listTo) + " (" + plural(n, "day") + ")";
  }
  function items() {
    return state.tab === "vans"
      ? VANS.map(function (v) { return { kind: "van", id: v.id, name: v.name }; })
      : MIFIS.map(function (m) { return { kind: "mifi", id: m.id, name: m.name }; });
  }
  function anyMifiFree(start, end) { return MIFIS.some(function (m) { return isFree("mifi", m.id, start, end); }); }

  function render() {
    const vans = state.tab === "vans";
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      const on = b.dataset.tab === state.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $("#panel").setAttribute("aria-labelledby", vans ? "tabVans" : "tabMifi");
    document.querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.view === state.view)); });
    $("#listFrom").value = state.listFrom;
    $("#listTo").value = state.listTo;
    $("#listTo").min = state.listFrom;
    $("#panelIntro").innerHTML = vans
      ? "Need a MiFi for the trip? Press <strong>Reserve ... + MiFi</strong> and the first open MiFi is added for you."
      : "Reserve a MiFi on its own, for example for travel in your own car. Already reserved a van? Reserve a MiFi here for the same dates. Booking a van now? Use the Vans tab and press <strong>Reserve ... + MiFi</strong>.";
    $("#tableView").hidden = state.view !== "table";
    $("#cardsView").hidden = state.view !== "cards";
    $("#calendarView").hidden = state.view !== "calendar";
    if (state.view === "table") renderTable();
    else if (state.view === "cards") renderCards();
    else { renderCalendar(); renderDay(); }
  }

  // Status, holders, dates, and action for one van or MiFi across the chosen range
  function describe(it) {
    const from = state.listFrom, to = state.listTo, today = todayISO();
    const hits = overlapping(it.kind, it.id, from, to);
    const mine = state.reservations.filter(function (r) { return r[it.kind] === it.id; });
    const overdue = mine.filter(isOverdue)[0];
    const d = { hits: hits, busy: hits.length > 0 };
    if (d.busy) {
      const st = statusOf(hits[0]);
      d.status = stTag(st.cls === "done" ? "done" : "busy", st.text === "Returned" ? "Returned early" : st.text);
      d.who = hits.map(function (r) {
        const other = it.kind === "van" ? (r.mifi ? " (with " + mifiName(r.mifi) + ")" : "") : (r.van ? " (with " + vanName(r.van) + ")" : "");
        return esc(r.team) + other;
      }).join("<br>");
      d.dates = hits.map(function (r) { return esc(fmtRange(r.startDate, r.endDate)); }).join("<br>");
      const free = nextFreeDay(it.kind, it.id, hits[0].startDate > from ? hits[0].startDate : from);
      d.action = '<span class="na">Not available. ' + (free ? "Open again " + esc(fmtDay(free)) + "." : "") + "</span>";
    } else {
      d.status = stTag("ok", "Available");
      d.who = "None";
      d.dates = "Open " + (from === to ? "that day" : "all " + plural(dayCount(from, to), "day"));
      if (from < today) {
        d.action = '<span class="na">Pick today or later to reserve.</span>';
      } else if (it.kind === "van") {
        const canMifi = anyMifiFree(from, to);
        d.action = '<div class="btn-row">' +
          '<button type="button" class="btn green" data-reserve="van" data-id="' + esc(it.id) + '">Reserve ' + esc(it.name) + "</button>" +
          '<button type="button" class="btn green-outline" data-reserve="van+mifi" data-id="' + esc(it.id) + '"' + (canMifi ? "" : " disabled") + ">" +
          (canMifi ? "Reserve " + esc(it.name) + " + MiFi" : "No MiFi open") + "</button></div>";
      } else {
        d.action = '<button type="button" class="btn green" data-reserve="mifi" data-id="' + esc(it.id) + '">Reserve ' + esc(it.name) + "</button>";
      }
    }
    d.extra = (overdue ? '<span class="sub issue">' + SYM.late + " Return form not received: " + esc(overdue.team) + ", " + esc(fmtRange(overdue.startDate, overdue.endDate)) + "</span>" : "") +
      (it.kind === "van" ? returnLine(lastReturn("van", it.id)) : "");
    return d;
  }

  function renderTable() {
    const vans = state.tab === "vans";
    const rows = items().map(function (it) {
      const d = describe(it);
      return '<tr class="' + (d.busy ? "busy" : "") + '"><th scope="row">' + esc(it.name) + "</th>" +
        '<td data-label="Status">' + d.status + d.extra + '</td><td data-label="Reserved by">' + d.who + '</td><td data-label="Dates">' + d.dates +
        '</td><td class="actions" data-label="Action">' + d.action + "</td></tr>";
    }).join("");
    $("#tableView").innerHTML = '<div class="table-box"><table><caption>' + (vans ? "Vans" : "MiFi hotspots") + ", " + esc(rangeText()) + "</caption>" +
      '<thead><tr><th scope="col">' + (vans ? "Van" : "MiFi") + '</th><th scope="col">Status</th><th scope="col">Reserved by</th><th scope="col">Dates</th><th scope="col">Action</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function renderCards() {
    const today = todayISO();
    $("#cardsView").innerHTML = items().map(function (it) {
      const d = describe(it);
      const upcoming = state.reservations.filter(function (r) { return r[it.kind] === it.id && !isReturned(r) && r.endDate >= today; });
      const list = upcoming.length
        ? '<ul class="trips">' + upcoming.map(function (r) {
            return "<li><strong>" + esc(fmtRange(r.startDate, r.endDate)) + "</strong>, " + esc(r.team) + " " + stTag(statusOf(r).cls, statusOf(r).text) + "</li>";
          }).join("") + "</ul>"
        : '<p class="hint">No upcoming reservations.</p>';
      return '<article class="card"><h3>' + esc(it.name) + "</h3><p>" + d.status + "</p>" +
        (d.busy ? "<p>" + d.who + "<br>" + d.dates + "</p>" : "<p>" + d.dates + "</p>") + d.extra +
        "<h4>Upcoming reservations</h4>" + list + "<div>" + d.action + "</div></article>";
    }).join("");
  }

  function renderCalendar() {
    const m = state.month, today = todayISO(), kind = state.tab === "vans" ? "van" : "mifi";
    const first = fromISO(m);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
    const start = addDays(m, -first.getDay());
    $("#calHeading").textContent = fmt(m, { month: "long", year: "numeric" }) + (kind === "van" ? ", vans" : ", MiFi hotspots");
    let html = "";
    for (let i = 0; i < cells; i++) {
      const d = addDays(start, i);
      const res = state.reservations.filter(function (r) { return r[kind] && r.startDate <= d && blockEnd(r) >= d; });
      const cls = ["day"];
      if (d.slice(0, 7) !== m.slice(0, 7)) cls.push("out");
      if (d < today) cls.push("past");
      if (d === today) cls.push("today");
      const label = fmtLong(d) + ": " + (res.length
        ? res.length + " reserved. " + res.map(function (r) { return itemName(kind, r[kind]) + ", " + r.team + ", " + statusOf(r).text; }).join("; ")
        : "everything open");
      const chips = res.length
        ? res.map(function (r) {
            const st = statusOf(r);
            const short = kind === "van" ? r.van : "MiFi " + r.mifi;
            return '<span class="chip ' + (st.cls === "busy" ? "" : st.cls) + '">' + SYM[st.cls] + " " + esc(short) + " " + esc(r.team) + "</span>";
          }).join("")
        : (d >= today ? '<span class="open">' + SYM.ok + " All open</span>" : "");
      const count = res.length ? '<span class="count">' + res.length + " out</span>" : (d >= today ? '<span class="count">Open</span>' : "");
      html += '<button type="button" class="' + cls.join(" ") + '" data-day="' + d + '" aria-pressed="' + (d === state.selectedDay) + '" aria-label="' + esc(label) + '">' +
        '<span class="daynum" aria-hidden="true">' + fromISO(d).getDate() + '</span><span class="chips" aria-hidden="true">' + chips + '</span><span aria-hidden="true">' + count + "</span></button>";
    }
    $("#calGrid").innerHTML = html;
  }

  function renderDay() {
    const d = state.selectedDay, today = todayISO();
    $("#dayHeading").textContent = fmtLong(d);
    $("#dayDetail").innerHTML = '<ul class="day-list">' + items().map(function (it) {
      const r = overlapping(it.kind, it.id, d, d)[0];
      if (r) {
        const st = statusOf(r);
        return "<li>" + stTag(st.cls, st.text) + '<span class="name">' + esc(it.name) + '</span><span class="info"><strong>' + esc(r.team) + "</strong>, " +
          esc(fmtRange(r.startDate, r.endDate)) + (r.destination ? " (" + esc(r.destination) + ")" : "") + "</span></li>";
      }
      return "<li>" + stTag("ok", "Available") + '<span class="name">' + esc(it.name) + "</span>" +
        (d >= today ? '<button type="button" class="btn green" data-reserve="' + it.kind + '" data-id="' + esc(it.id) + '" data-date="' + d + '">Reserve ' + esc(it.name) + "</button>" : "") + "</li>";
    }).join("") + "</ul>";
  }

  /* ================= Booking and modifying: one step at a time ================= */

  // opts: { mode: "van"|"mifi", van, mifi, start, end, editing, step }
  function openWizard(opts) {
    opts = opts || {};
    if (AUTH_ON && !account) { signIn({ mode: opts.mode, van: opts.van, mifi: opts.mifi, start: opts.start, end: opts.end }); return; }
    const today = todayISO();
    const prefs = storageGet(PREFS_KEY) || {};
    const ed = opts.editing ? state.mine.find(function (x) { return x.id === opts.editing; }) : null;
    const start = opts.start && opts.start >= today ? opts.start : today;
    const end = opts.end && opts.end >= start ? opts.end : start;
    wiz = {
      step: opts.step || 1,
      editing: ed,
      started: !!(ed && ed.startDate < today),
      mode: ed ? (ed.van ? "van" : "mifi") : (opts.mode || "van"),
      start: ed ? ed.startDate : start,
      end: ed ? ed.endDate : end,
      van: ed ? ed.van : (opts.van || ""),
      mifi: ed ? ed.mifi : (opts.mifi || ""),
      team: ed ? ed.team : (prefs.team || ""),
      driver: ed ? ed.driver : (prefs.driver || (account ? account.name || "" : "")),
      email: ed ? ed.email : (prefs.email || ""),
      destination: ed ? ed.destination : "",
      notes: ed ? ed.notes : ""
    };
    $("#bookTitle").textContent = ed ? "Modify reservation " + ed.id : (wiz.mode === "mifi" ? "Reserve a MiFi" : "Reserve a van");
    $("#formError").textContent = "";
    $("#signedInAs").hidden = !(AUTH_ON && account);
    if (AUTH_ON && account) $("#signedInAs").textContent = "Reserving as " + (account.name || "") + " (" + signedInEmail() + ")";
    renderWizard();
    if (!$("#bookDialog").open) $("#bookDialog").showModal();
    const first = $("#wizBody").querySelector("input:not([disabled]), select");
    if (first) first.focus();
  }

  // Why a van or MiFi can't be picked for the chosen dates (empty if it can)
  function whyNot(kind, id) {
    if (wiz.started && wiz.editing && wiz.editing[kind] !== id) return "Your trip has already started, so this can't be switched.";
    const hit = overlapping(kind, id, wiz.start, wiz.end, wiz.editing ? wiz.editing.id : null)[0];
    return hit ? "Reserved: " + hit.team + ", " + fmtRange(hit.startDate, hit.endDate) : "";
  }

  function choiceHtml(name, value, label, reason, checked) {
    return '<label class="choice' + (reason ? " unavailable" : "") + '"><input type="radio" name="' + name + '" value="' + esc(value) + '"' +
      (checked && !reason ? " checked" : "") + (reason ? " disabled" : "") + "><span>" + esc(label) +
      (reason ? '<span class="why">' + SYM.busy + " " + esc(reason) + "</span>" : "") + "</span></label>";
  }

  function renderWizard() {
    const s = wiz.step;
    $("#steps").innerHTML = STEP_NAMES.map(function (n, i) {
      const k = i + 1;
      return '<li class="' + (k < s ? "done" : k === s ? "now" : "") + '"' + (k === s ? ' aria-current="step"' : "") +
        '><span class="bar"></span><span><strong>' + k + ". " + n + "</strong><br>" + (k < s ? "Done" : k === s ? "Now" : "&nbsp;") + "</span></li>";
    }).join("");
    $("#backBtn").hidden = s === 1;
    $("#nextBtn").textContent = s < 4 ? "Next: " + STEP_NAMES[s] : (wiz.editing ? "Save changes" : "Reserve");
    const body = $("#wizBody");
    const n = dayCount(wiz.start, wiz.end);
    const datesBar = '<div class="summary-bar"><span><strong>Dates:</strong> ' + esc(fmtRange(wiz.start, wiz.end)) + " (" + plural(n, "full day") + ")</span>" +
      '<button type="button" class="btn outline" data-goto="1">Change dates</button></div>';

    if (s === 1) {
      body.innerHTML =
        "<fieldset><legend>When do you need it?</legend>" +
        '<p class="hint">Reservations are for full days, from 12:00 AM on the first day to 11:59 PM on the last day.</p>' +
        '<div class="row2"><label for="wStart">First day<input type="date" id="wStart" value="' + wiz.start + '" min="' + (wiz.started ? wiz.start : todayISO()) + '"' + (wiz.started ? " disabled" : "") + "></label>" +
        '<label for="wEnd">Last day<input type="date" id="wEnd" value="' + wiz.end + '" min="' + (wiz.start > todayISO() ? wiz.start : todayISO()) + '"></label></div>' +
        '<p class="hint" id="wDays">' + plural(n, "full day") + ": " + esc(fmtRange(wiz.start, wiz.end)) + "</p>" +
        (wiz.started ? '<p class="note-box">This trip has already started, so the first day, van, and MiFi stay the same. You can change the last day and your details.</p>' : "") +
        "</fieldset>";
    } else if (s === 2) {
      let html = datesBar;
      if (wiz.mode === "van") {
        const open = VANS.filter(function (v) { return !whyNot("van", v.id); }).length;
        html += '<fieldset><legend>Choose a van</legend><p class="hint">' + open + " of " + VANS.length + " vans are open for these dates. Reserved vans are shown so you can see who has them.</p>" +
          '<div class="choices">' + VANS.map(function (v) { return choiceHtml("wVan", v.id, v.name, whyNot("van", v.id), wiz.van === v.id); }).join("") + "</div></fieldset>";
        html += '<fieldset><legend>Add a MiFi hotspot? (optional)</legend><p class="hint">A van and MiFi booked together stay together if you modify or cancel.</p>' +
          '<div class="choices">' + choiceHtml("wMifi", "", "No MiFi", wiz.started && wiz.editing && wiz.editing.mifi ? "Your trip has already started, so this can't be switched." : "", !wiz.mifi) +
          MIFIS.map(function (m) { return choiceHtml("wMifi", m.id, m.name, whyNot("mifi", m.id), wiz.mifi === m.id); }).join("") + "</div></fieldset>";
      } else {
        const open = MIFIS.filter(function (m) { return !whyNot("mifi", m.id); }).length;
        html += '<fieldset><legend>Choose a MiFi hotspot</legend><p class="hint">' + open + " of " + MIFIS.length + " MiFis are open for these dates. Reserved ones are shown so you can see who has them.</p>" +
          '<div class="choices">' + MIFIS.map(function (m) { return choiceHtml("wMifi", m.id, m.name, whyNot("mifi", m.id), wiz.mifi === m.id); }).join("") + "</div></fieldset>";
      }
      body.innerHTML = html;
    } else if (s === 3) {
      const teams = CFG.teams || [];
      const known = !wiz.team || teams.indexOf(wiz.team) !== -1;
      body.innerHTML =
        '<fieldset><legend>Your details</legend><div class="wiz-body">' +
        '<label for="wTeam">Team<select id="wTeam"><option value="">Choose a team</option>' +
        teams.map(function (t) { return '<option value="' + esc(t) + '"' + (t === wiz.team ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
        '<option value="__other"' + (known ? "" : " selected") + ">Other</option></select></label>" +
        '<label for="wOther"' + (known ? " hidden" : "") + ' id="wOtherWrap">Team or group name<input type="text" id="wOther" value="' + (known ? "" : esc(wiz.team)) + '"></label>' +
        '<label for="wDriver">Driver name<input type="text" id="wDriver" autocomplete="name" value="' + esc(wiz.driver) + '"></label>' +
        (AUTH_ON ? "" : '<label for="wEmail">W&amp;L email<input type="email" id="wEmail" autocomplete="email" placeholder="name@wlu.edu" value="' + esc(wiz.email) + '"></label>') +
        '<label for="wDest">Destination or event (optional)<input type="text" id="wDest" value="' + esc(wiz.destination) + '"></label>' +
        '<label for="wNotes">Notes (optional)<textarea id="wNotes" rows="2">' + esc(wiz.notes) + "</textarea></label></div></fieldset>";
    } else {
      const row = function (label, value, step) {
        return "<dt>" + label + "</dt><dd>" + value + "</dd>" + (step ? '<dd class="edit"><button type="button" class="btn outline" data-goto="' + step + '">Edit</button></dd>' : "<dd></dd>");
      };
      body.innerHTML =
        '<fieldset><legend>Review</legend><dl class="review">' +
        row("Dates", esc(fmtRange(wiz.start, wiz.end)) + " (" + plural(n, "full day") + ")", 1) +
        (wiz.mode === "van" ? row("Van", esc(vanName(wiz.van)), 2) : "") +
        row("MiFi", wiz.mifi ? esc(mifiName(wiz.mifi)) : "None", 2) +
        row("Team", esc(wiz.team), 3) +
        row("Driver", esc(wiz.driver), 3) +
        row("Email", esc(AUTH_ON && account ? signedInEmail() : wiz.email), AUTH_ON ? 0 : 3) +
        row("Destination", esc(wiz.destination || "None"), 3) +
        row("Notes", esc(wiz.notes || "None"), 3) +
        "</dl></fieldset>" +
        '<p class="note-box">' + (wiz.editing
          ? "Nothing changes until you press <strong>Save changes</strong>."
          : "Nothing is reserved until you press <strong>Reserve</strong>. You can modify or cancel later.") + "</p>";
    }
  }

  // Save what is on screen into wiz
  function collect() {
    const s = wiz.step;
    if (s === 1) {
      if (!wiz.started) wiz.start = $("#wStart").value;
      wiz.end = $("#wEnd").value;
    } else if (s === 2) {
      const v = document.querySelector('input[name="wVan"]:checked');
      const m = document.querySelector('input[name="wMifi"]:checked');
      if (wiz.mode === "van") wiz.van = v ? v.value : "";
      wiz.mifi = m ? m.value : "";
    } else if (s === 3) {
      wiz.team = $("#wTeam").value === "__other" ? $("#wOther").value.trim() : $("#wTeam").value;
      wiz.driver = $("#wDriver").value.trim();
      if (!AUTH_ON) wiz.email = $("#wEmail").value.trim().toLowerCase();
      wiz.destination = $("#wDest").value.trim();
      wiz.notes = $("#wNotes").value.trim();
    }
  }

  function checkStep() {
    const s = wiz.step, today = todayISO();
    if (s === 1) {
      if (!wiz.start || !wiz.end) return "Choose a first and last day.";
      if (wiz.start < today && !wiz.started) return "The first day can't be in the past.";
      if (wiz.end < wiz.start) return "The last day must be on or after the first day.";
      if (wiz.end < today) return "The last day can't be in the past.";
      if (CFG.maxDays && dayCount(wiz.start, wiz.end) > CFG.maxDays) return "Reservations can be at most " + CFG.maxDays + " days.";
    } else if (s === 2) {
      if (wiz.mode === "van" && !wiz.van) return "Choose a van. Greyed-out vans are already reserved for these dates.";
      if (wiz.mode === "mifi" && !wiz.mifi) return "Choose a MiFi. Greyed-out MiFis are already reserved for these dates.";
      if (wiz.van && whyNot("van", wiz.van)) return vanName(wiz.van) + " is not open for these dates. Please choose another.";
      if (wiz.mifi && whyNot("mifi", wiz.mifi)) return mifiName(wiz.mifi) + " is not open for these dates. Please choose another.";
    } else if (s === 3) {
      if (!wiz.team) return "Choose your team.";
      if (!wiz.driver) return "Enter the driver's name.";
      const email = AUTH_ON && account ? signedInEmail() : wiz.email;
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || (DOMAIN && !email.endsWith("@" + DOMAIN))) {
        return AUTH_ON ? "Please sign in with your W&L account." : "Enter your @" + DOMAIN + " email address.";
      }
    }
    return "";
  }

  function goStep(n) {
    wiz.step = n;
    $("#formError").textContent = "";
    // Dates changed: drop a picked van or MiFi that is no longer open
    if (n === 2) {
      if (wiz.van && whyNot("van", wiz.van)) wiz.van = "";
      if (wiz.mifi && whyNot("mifi", wiz.mifi)) wiz.mifi = "";
    }
    renderWizard();
    const h = $("#wizBody").querySelector("legend");
    if (h) { h.tabIndex = -1; h.focus(); }
  }

  async function onNext(ev) {
    ev.preventDefault();
    collect();
    const problem = checkStep();
    if (problem) { $("#formError").textContent = problem; return; }
    if (wiz.step < 4) { goStep(wiz.step + 1); return; }
    await submitWizard();
  }

  async function submitWizard() {
    const btn = $("#nextBtn");
    btn.disabled = true;
    btn.textContent = "Checking...";
    try {
      await load(true);   // latest reservations, so nobody books over someone else
      const taken = (wiz.van && whyNot("van", wiz.van)) || (wiz.mifi && whyNot("mifi", wiz.mifi));
      if (taken) {
        goStep(2);
        $("#formError").textContent = "Sorry, something you picked was just reserved by someone else. Please choose again.";
        return;
      }
      btn.textContent = wiz.editing ? "Saving..." : "Reserving...";
      const email = AUTH_ON && account ? signedInEmail() : wiz.email;
      const payload = {
        id: wiz.editing ? wiz.editing.id : undefined,
        van: wiz.mode === "van" ? wiz.van : "",
        mifi: wiz.mifi,
        startDate: wiz.start, endDate: wiz.end,
        team: wiz.team, driver: wiz.driver, email: email,
        reservedBy: account ? (account.name || email) : wiz.driver,
        destination: wiz.destination, notes: wiz.notes
      };
      const result = await api(wiz.editing ? "update" : "book", payload);
      if (!result.ok) {
        const msg = result.message || "Sorry, something you picked was just reserved. Please choose again.";
        await load(true);
        if (result.conflict) goStep(2);
        $("#formError").textContent = msg;
        return;
      }
      storageSet(PREFS_KEY, Object.assign(storageGet(PREFS_KEY) || {}, { team: wiz.team, driver: wiz.driver, email: AUTH_ON ? "" : email }));
      const label = itemLabel(payload);
      const editing = wiz.editing;
      $("#bookDialog").close();
      toast(editing
        ? "Saved. Reservation " + editing.id + " is now " + label + ", " + fmtRange(payload.startDate, payload.endDate) + "."
        : "Reserved: " + label + " for " + payload.team + ", " + fmtRange(payload.startDate, payload.endDate) + ". Your reservation number is " + (result.id || "") + ".");
      await load(true);
      if (editing) openMine();
    } catch (x) {
      console.error(x);
      $("#formError").textContent = "Something went wrong and nothing was saved. Please try again.";
    } finally {
      btn.disabled = false;
      if (wiz) btn.textContent = wiz.step < 4 ? "Next: " + STEP_NAMES[wiz.step] : (wiz.editing ? "Save changes" : "Reserve");
    }
  }

  /* ================= Modify or Cancel Reservation ================= */

  function mineEmail() {
    if (AUTH_ON && account) return signedInEmail();
    return String($("#mineEmail").value || (storageGet(PREFS_KEY) || {}).email || "").trim().toLowerCase();
  }
  function openMine() {
    if (AUTH_ON && !account) { signIn({ mine: true }); return; }
    $("#mineList").innerHTML = "";
    $("#mineStatus").textContent = "";
    $("#mineLookup").hidden = AUTH_ON;
    if (!AUTH_ON) $("#mineEmail").value = (storageGet(PREFS_KEY) || {}).email || "";
    if (!$("#mineDialog").open) $("#mineDialog").showModal();
    if (AUTH_ON || $("#mineEmail").value) refreshMine();
  }
  async function refreshMine() {
    const email = mineEmail();
    if (!AUTH_ON && (!email || (DOMAIN && !email.endsWith("@" + DOMAIN)))) {
      $("#mineStatus").textContent = "Enter the @" + DOMAIN + " email you used when you booked.";
      return;
    }
    $("#mineStatus").textContent = "Loading...";
    try {
      const res = await api("mine", { email: email });
      if (!res.ok) { $("#mineStatus").textContent = res.message || "Could not load your reservations."; return; }
      state.mine = (res.reservations || []).map(normalize);
      state.mineAdmin = !!res.admin;
      renderMine();
    } catch (x) {
      console.error(x);
      $("#mineStatus").textContent = "Could not load your reservations. Please try again.";
    }
  }
  function renderMine() {
    const today = todayISO();
    $("#mineStatus").textContent = state.mine.length
      ? (state.mineAdmin ? "Admin view: all upcoming reservations." : "")
      : "You have no upcoming reservations.";
    $("#mineList").innerHTML = state.mine.map(function (r) {
      const started = r.startDate < today;
      const words = bundleWords(r);
      return '<li class="mine-item"><div><p class="what">' + esc(itemLabel(r)) + (started ? " " + stTag("busy", "In use") : "") + "</p>" +
        "<p>" + esc(fmtRange(r.startDate, r.endDate)) + "</p>" +
        '<p class="hint">' + esc(r.team) + (r.destination ? ", " + esc(r.destination) : "") + ". Reservation " + esc(r.id) +
        (state.mineAdmin && r.email ? ", " + esc(r.email) : "") + "</p></div>" +
        '<div class="btn-row"><button type="button" class="btn blue" data-modify="' + esc(r.id) + '">Modify ' + words + "</button>" +
        (started && !state.mineAdmin ? "" : '<button type="button" class="btn danger" data-cancel="' + esc(r.id) + '">Cancel ' + words + "</button>") +
        "</div></li>";
    }).join("");
  }
  async function cancelReservation(id) {
    const r = state.mine.find(function (x) { return x.id === id; });
    if (!r) return;
    const both = r.van && r.mifi ? "\n\nThe van and MiFi are booked together, so both will be cancelled." : "";
    if (!window.confirm("Cancel " + itemLabel(r) + " for " + r.team + ", " + fmtRange(r.startDate, r.endDate) + "?" + both)) return;
    $("#mineStatus").textContent = "Cancelling...";
    try {
      const res = await api("cancel", { id: id, email: mineEmail() });
      if (!res.ok) { $("#mineStatus").textContent = res.message || "Could not cancel. Please try again."; return; }
      toast("Cancelled reservation " + id + ". " + itemLabel(r) + " is open again for those dates.");
      await load(true);
      await refreshMine();
    } catch (x) {
      console.error(x);
      $("#mineStatus").textContent = "Could not cancel. Please try again.";
    }
  }

  /* ================= Events ================= */

  function wire() {
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      const reserve = t.closest("[data-reserve]");
      if (reserve) {
        const kind = reserve.dataset.reserve, id = reserve.dataset.id;
        const start = reserve.dataset.date || state.listFrom, end = reserve.dataset.date || state.listTo;
        if (kind === "mifi") openWizard({ mode: "mifi", mifi: id, start: start, end: end, step: 2 });
        else {
          let mifi = "";
          if (kind === "van+mifi") { const m = MIFIS.find(function (x) { return isFree("mifi", x.id, start, end); }); mifi = m ? m.id : ""; }
          openWizard({ mode: "van", van: id, mifi: mifi, start: start, end: end, step: 2 });
        }
        return;
      }
      const go = t.closest("[data-goto]");
      if (go && wiz) { collect(); goStep(Number(go.dataset.goto)); return; }
      const modify = t.closest("[data-modify]");
      if (modify) { $("#mineDialog").close(); openWizard({ editing: modify.dataset.modify, step: 1 }); return; }
      const cancel = t.closest("[data-cancel]");
      if (cancel) { cancelReservation(cancel.dataset.cancel); return; }
      const day = t.closest("[data-day]");
      if (day) {
        state.selectedDay = day.dataset.day;
        if (state.selectedDay.slice(0, 7) !== state.month.slice(0, 7)) state.month = state.selectedDay.slice(0, 8) + "01";
        renderCalendar(); renderDay();
        const again = document.querySelector('[data-day="' + state.selectedDay + '"]');
        if (again) again.focus();
        return;
      }
      const tab = t.closest("[data-tab]");
      if (tab) { state.tab = tab.dataset.tab; storageSet(PREFS_KEY + "-tab", state.tab); render(); return; }
      const view = t.closest("[data-view]");
      if (view) { state.view = view.dataset.view; storageSet(PREFS_KEY + "-view", state.view); render(); return; }
      const size = t.closest("[data-size]");
      if (size) { setDisplay({ size: Number(size.dataset.size) }); return; }
      if (t.id === "signInBtn") signIn();
      if (t.id === "signOutBtn") signOut();
    });

    // Arrow keys move between the two tabs
    $(".tabs").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      state.tab = state.tab === "vans" ? "mifi" : "vans";
      render();
      document.querySelector('[data-tab="' + state.tab + '"]').focus();
    });

    $("#contrastBtn").addEventListener("click", function () { setDisplay({ hc: !loadDisplay().hc }); });
    $("#darkBtn").addEventListener("click", function () { setDisplay({ dark: !loadDisplay().dark }); });
    $("#motionBtn").addEventListener("click", function () { setDisplay({ rm: !loadDisplay().rm }); });

    $("#reserveBtn").addEventListener("click", function () {
      openWizard({ mode: state.tab === "mifi" ? "mifi" : "van", start: state.listFrom, end: state.listTo, step: 1 });
    });
    $("#mineBtn").addEventListener("click", openMine);

    $("#listFrom").addEventListener("change", function (e) {
      if (!e.target.value) return;
      state.listFrom = e.target.value;
      if (state.listTo < state.listFrom) state.listTo = state.listFrom;
      render();
    });
    $("#listTo").addEventListener("change", function (e) {
      if (!e.target.value) return;
      state.listTo = e.target.value < state.listFrom ? state.listFrom : e.target.value;
      render();
    });
    $("#prevMonth").addEventListener("click", function () { state.month = addMonths(state.month, -1); renderCalendar(); });
    $("#nextMonth").addEventListener("click", function () { state.month = addMonths(state.month, 1); renderCalendar(); });
    $("#todayBtn").addEventListener("click", function () {
      state.selectedDay = todayISO(); state.month = state.selectedDay.slice(0, 8) + "01"; renderCalendar(); renderDay();
    });

    // Booking form
    $("#bookForm").addEventListener("submit", onNext);
    $("#backBtn").addEventListener("click", function () { collect(); goStep(Math.max(1, wiz.step - 1)); });
    $("#closeBook").addEventListener("click", function () { $("#bookDialog").close(); });
    $("#bookDialog").addEventListener("close", function () { wiz = null; });
    $("#wizBody").addEventListener("change", function (e) {
      if (!wiz) return;
      if (e.target.id === "wTeam") $("#wOtherWrap").hidden = e.target.value !== "__other";
      if (e.target.id === "wStart" || e.target.id === "wEnd") {
        if (e.target.id === "wStart" && $("#wEnd").value < e.target.value) $("#wEnd").value = e.target.value;
        $("#wEnd").min = $("#wStart").value || todayISO();
        const s = $("#wStart").value, en = $("#wEnd").value;
        if (s && en && en >= s) $("#wDays").textContent = plural(dayCount(s, en), "full day") + ": " + fmtRange(s, en);
      }
    });

    // Modify or cancel
    $("#closeMine").addEventListener("click", function () { $("#mineDialog").close(); });
    $("#mineLookup").addEventListener("submit", function (e) {
      e.preventDefault();
      storageSet(PREFS_KEY, Object.assign(storageGet(PREFS_KEY) || {}, { email: $("#mineEmail").value.trim().toLowerCase() }));
      refreshMine();
    });

    // Keep the page current (returns show up within a minute)
    setInterval(function () { if (!document.hidden && !wiz) load(true); }, REFRESH_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !wiz) load(true); });
  }

  /* ================= Start ================= */

  async function start() {
    applyDisplay(loadDisplay());
    $("#demoBanner").hidden = !DEMO;
    const v = storageGet(PREFS_KEY + "-view");
    if (v === "table" || v === "cards" || v === "calendar") state.view = v;
    const t = storageGet(PREFS_KEY + "-tab");
    if (t === "vans" || t === "mifi") state.tab = t;
    wire();
    render();
    await load(false);
    await initAuth();
  }

  start();
})();
