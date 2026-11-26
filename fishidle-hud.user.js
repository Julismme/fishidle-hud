// ==UserScript==
// @name         FishIdle HUD
// @namespace    fishidle-plugin
// @version      1.1.1.20261126
// @description  fishidle.com 辅助面板：队列倒计时、升级预估、战斗监控（分均金币/药剂差额提醒）、死亡告警、收藏、发育计算器、渔舍计算器。
// @author      jojo
// @match        https://fishidle.com/game/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/julismme/fishidle-hud/main/fishidle-hud.user.js
// @updateURL    https://raw.githubusercontent.com/julismme/fishidle-hud/main/fishidle-hud.user.js
// ==/UserScript==

(() => {
  "use strict";
  const VERSION = "1.1.1.20261126";
  if (window.__FISHIDLE_HUD__) return;
  window.__FISHIDLE_HUD__ = true;

  function getPiniaStore(id) {
    const app = document.querySelector("#app")?.__vue_app__;
    return app?.config?.globalProperties?.$pinia?._s?.get(id) ?? null;
  }
  function getGameStore() {
    return getPiniaStore("game");
  }

  const CRAFT_XP_LS = "fishidle-hud.craftXp";
  const craftXp = new Map();
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem(CRAFT_XP_LS) || "[]")) craftXp.set(k, v);
  } catch {}
  function persistCraftXp() {
    try { localStorage.setItem(CRAFT_XP_LS, JSON.stringify([...craftXp])); } catch {}
  }
  const GATHER_XP_LS = "fishidle-hud.gatherXp";
  const gatherXp = new Map();
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem(GATHER_XP_LS) || "[]")) gatherXp.set(k, v);
  } catch {}
  function persistGatherXp() {
    try { localStorage.setItem(GATHER_XP_LS, JSON.stringify([...gatherXp])); } catch {}
  }
  const GATHER_CFG = { minIv: 2, maxIv: 25, maxLv: 200, maxSpd: 1.5, toolSpd: 0.06,
    xpPerTier: [10, 22, 42, 75, 130, 210, 330], tierLvCoef: 29, slope: 0.04, exp: 2.3, minPen: 0.001 };
  function gatherXpPer(tier, level) {
    const base = GATHER_CFG.xpPerTier[Math.max(0, Math.min((tier ?? 1) - 1, GATHER_CFG.xpPerTier.length - 1))] ?? 0;
    const over = level - (tier ?? 1) * GATHER_CFG.tierLvCoef;
    if (over <= 0) return base;
    const pen = Math.max(1 / (1 + over * GATHER_CFG.slope) ** GATHER_CFG.exp, GATHER_CFG.minPen);
    return Math.max(1, Math.round(base * pen));
  }
  function gatherInterval(tier, level, toolTier) {
    const t = (Math.max(1, Math.min(tier ?? 1, 7)) - 1) / 6;
    const base = GATHER_CFG.minIv * (GATHER_CFG.maxIv / GATHER_CFG.minIv) ** t;
    const spd = GATHER_CFG.maxLv <= 1 ? GATHER_CFG.maxSpd
      : 1 + Math.max(0, Math.min(1, (level - 1) / (GATHER_CFG.maxLv - 1))) * (GATHER_CFG.maxSpd - 1);
    const tool = toolTier <= 0 ? 1 : toolTier === 8 ? 1.6 : 1 + toolTier * GATHER_CFG.toolSpd;
    return Math.round((base / spd / tool) * 10) / 10;
  }
  const gatherToolTier = (g, st) =>
    (g?.equippedTools ?? []).find((t) => t.gatheringSkill === st && t.toolId != null)?.toolTier ?? 0;
  let storeHooked = false;
  function parseCraftTick(p, prof) {
    if (!p || typeof p !== "object" || !prof) return null;
    const lv = p.currentLevel ?? p.level, xp = p.currentXp ?? p.experience,
          next = p.nextLevelExp ?? p.nextLevelXp;
    if (!Number.isFinite(xp) || !Number.isFinite(next)) return null;
    return { prof, lv: Number.isFinite(lv) ? lv : null, xp, next, at: Date.now() };
  }
  function hookStore(g) {
    if (storeHooked || !g) return;
    try {
      const origPS = g.applyPlayerState;
      if (typeof origPS === "function") {
        g.applyPlayerState = function (p) {
          try {
            if (Array.isArray(p?.craftingSkills)) {
              for (const s of p.craftingSkills) {
                if (s?.profession && Number.isFinite(s.experience) && Number.isFinite(s.nextLevelExp))
                  craftXp.set(s.profession, { prof: s.profession, lv: s.level ?? null,
                    xp: s.experience, next: s.nextLevelExp, at: Date.now() });
              }
              persistCraftXp();
            }
          } catch {}
          return origPS.apply(this, arguments);
        };
      }
      if (typeof g.applyCraftTick === "function") {
        const orig = g.applyCraftTick;
        g.applyCraftTick = function (p) {
          try {
            const rec = parseCraftTick(p, g.currentActivity?.craftingProfession);
            if (rec) { craftXp.set(rec.prof, rec); persistCraftXp(); }
          } catch {}
          return orig.apply(this, arguments);
        };
      }
      if (typeof g.applyAlchemyTick === "function") {
        const origAl = g.applyAlchemyTick;
        g.applyAlchemyTick = function (p) {
          try {
            const rec = parseCraftTick(p, isAlchemyActivity(g.currentActivity) ? "Alchemy" : null);
            if (rec) { craftXp.set(rec.prof, rec); persistCraftXp(); }
          } catch {}
          return origAl.apply(this, arguments);
        };
      }
      const origAT = g.applyTick;
      if (typeof origAT === "function") {
        g.applyTick = function (p) {
          try {
            const cur = g.currentActivity;
            const st = cur?.skillType, rid = cur?.resourceId;
            if (st && rid != null && p && Number.isFinite(p.currentXp)) {
              const key = st + "|" + rid;
              const prev = gatherXp.get(key) ?? {};
              const per = prev.prevXp != null && p.currentXp > prev.prevXp
                ? p.currentXp - prev.prevXp : prev.per ?? null;
              gatherXp.set(key, { skillType: st, resourceId: rid, prevXp: p.currentXp, per,
                tick: Number.isFinite(p.tickIntervalSeconds) ? p.tickIntervalSeconds : prev.tick ?? null, at: Date.now() });
              persistGatherXp();
            }
          } catch {}
          return origAT.apply(this, arguments);
        };
      }
      storeHooked = true;
      hookProbe(g);
    } catch {}
  }
  const hookTimer = setInterval(() => {
    if (storeHooked) { clearInterval(hookTimer); return; }
    hookStore(getGameStore());
  }, 100);
  function isEnhancementActivity(a) {
    return !!a && (a.enhancementTargetItemId != null || a.type === "Enhancement" || a.activityType === "Enhancement");
  }
  function isAlchemyActivity(a) {
    return !!a && (a.alchemyItemId != null || a.type === "Alchemy" || a.activityType === "Alchemy");
  }
  function isCraftingActivity(a) {
    return !!a && a.resourceId == null && a.locationId == null && a.craftingRecipeId != null;
  }
  function activityLabel(e, g) {
    if (!e) return "当前活动";
    if (e.type === "Combat") {
      const z = (g?.combatZones ?? []).find((x) => x.id === e.combatZoneId);
      return "战斗·" + (z?.name ?? `#${e.combatZoneId ?? "?"}`);
    }
    if (isEnhancementActivity(e))
      return "强化·" + (e.enhancementTargetItemName ?? `#${e.enhancementTargetItemId}`);
    if (isAlchemyActivity(e))
      return "炼金·" + (e.alchemyItemName ?? `#${e.alchemyItemId}`);
    if (e.type === "Gathering" || e.resourceId != null || e.locationId != null) return zh(e.skillType ?? "采集");
    if (e.type === "Crafting" || isCraftingActivity(e)) return zh(e.craftingProfession ?? "制造");
    return zh(e.craftingProfession ?? e.skillType ?? e.activityType ?? e.name ?? "当前活动");
  }
  function computeCraftCtx(cur, recipes, inv, skillTick) {
    if (!isCraftingActivity(cur) || !cur?.craftingProfession) return null;
    const r = recipes.get(cur.craftingRecipeId);
    if (!r || !Number.isFinite(r.xpPerCraft) || r.xpPerCraft <= 0) return null;
    const timePerCraft = skillTick.get(cur.craftingProfession) ?? r.baseTickIntervalSeconds;
    if (!Number.isFinite(timePerCraft) || timePerCraft <= 0) return null;
    const mats = (r.ingredients ?? []).map((i) => ({
      name: i.name ?? `#${i.itemId}`, per: i.quantity || 1, have: inv.get(i.itemId) ?? 0 }));
    const possible = mats.length
      ? Math.min(...mats.map((m) => Math.floor(m.have / m.per))) : Infinity;
    const plannedRaw = Number.isFinite(cur.remainingCount) ? cur.remainingCount
      : (Number.isFinite(cur.remainingTicks) ? cur.remainingTicks : null);
    const planned = plannedRaw === 0 ? Infinity : plannedRaw;
    const actual = Math.max(0, Math.min(planned ?? possible, possible));
    return { r, timePerCraft, mats, possible, planned: plannedRaw, actual,
      short: Number.isFinite(planned) && possible < planned,
      eta: actual * timePerCraft };
  }
  const fmtDur = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    sec = Math.round(sec);
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
      m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d > 0) return `${d}天${h}小时`;
    if (h > 0) return `${h}时${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  };
  const fmtClock = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    const end = new Date(Date.now() + sec * 1000);
    return `${fmtDur(sec)}（约 ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}）`;
  };

  function tickEta(e, ctx) {
    if (e == null) return null;
    if (Number.isFinite(e.remainingTicks)) {
      const t = e.tickIntervalSeconds ?? e.fallbackIntervalSeconds ?? 5;
      const w = e.tickWindow;
      const curLeft = (w && w.durationMs > 0
        ? Math.min(t, Math.max(0, (w.startedAtLocal + w.durationMs - ctx.nowMs) / 1000))
        : Math.min(t, Math.max(0, (new Date(e.nextTickAt).getTime() - ctx.nowMs) / 1000)));
      return { sec: curLeft + Math.max(0, e.remainingTicks - 1) * t, est: false };
    }
    if (e.remainingCount === 0) return { inf: true };
    if (e.remainingCount == null && e.remainingTicks == null) return { inf: true };
    if (e.type === "Combat") return null;
    if (isEnhancementActivity(e) || isAlchemyActivity(e)) return null;

    if (e.type === "Crafting" && e.craftingRecipeId != null) {
      const r = ctx.recipes.get(e.craftingRecipeId);
      if (!r) return null;
      const t = ctx.skillTick.get(e.craftingProfession) ?? r.baseTickIntervalSeconds;
      if (!Number.isFinite(t) || t <= 0) return null;
      const need = Number.isFinite(e.remainingCount) ? e.remainingCount : null;
      let possible = need;
      if (need != null && r.ingredients?.length) {
        possible = Math.min(...r.ingredients.map((i) =>
          Math.floor((ctx.inv.get(i.itemId) ?? 0) / (i.quantity || 1))));
      }
      if (possible == null) return null;
      if (possible <= 0) return { sec: 0, est: true, short: true };
      return { sec: possible * t, est: true, short: need != null && possible < need, possible, need };
    }

    const ty = e.skillType ?? e.craftingProfession;
    const t = ctx.skillTick.get(ty);
    if (Number.isFinite(e.remainingCount) && e.remainingCount > 0 && Number.isFinite(t) && t > 0)
      return { sec: e.remainingCount * t, est: true };
    return null;
  }
  const etaVal = (eta, withClock) => {
    if (!eta) return "—";
    if (eta.inf) return "∞";
    const txt = withClock ? fmtClock(eta.sec) : fmtDur(eta.sec);
    if (eta.short) return `缺料（${eta.possible ?? 0}/${eta.need ?? "?"}）`;
    return (eta.est ? "≈ " : "") + txt;
  };

  const RATE_WINDOW_MS = 300_000, RATE_MIN_SPAN_MS = 6_000, RATE_FRESH_MS = 120_000;
  const series = new Map(), smoothed = new Map();
  function track(key, xp, now) {
    let arr = series.get(key);
    if (!arr) { arr = []; series.set(key, arr); }
    const last = arr[arr.length - 1];
    if (!last || last.xp !== xp) arr.push({ t: now, xp });
    while (arr.length > 2 && now - arr[0].t > RATE_WINDOW_MS) arr.shift();
  }
  function rateOf(key, now) {
    const arr = series.get(key);
    if (!arr || arr.length < 2) return null;
    const dt = (arr[arr.length - 1].t - arr[0].t) / 1000;
    if (dt * 1000 < RATE_MIN_SPAN_MS) return null;
    const raw = (arr[arr.length - 1].xp - arr[0].xp) / dt;
    if (raw <= 0) return null;
    const prev = smoothed.get(key);
    const sm = prev == null ? raw : prev * 0.7 + raw * 0.3;
    smoothed.set(key, sm);
    return { xpPerSec: sm, lastChange: arr[arr.length - 1].t };
  }

  const SKILL_ZH = {
    Gathering: "采集", Logging: "伐木", Mining: "采矿", Fishing: "钓鱼",
    Artisan: "工匠", Crafting: "工匠", Smith: "锻造", Smithing: "锻造",
    Tailor: "裁缝", Tailoring: "裁缝", Alchemist: "炼金", Alchemy: "炼金",
    Cooking: "烹饪", Enhancement: "强化", Enchanting: "附魔", Melee: "近战", Ranged: "远程", Magic: "法术",
    Defense: "防御", Endurance: "耐力", Strength: "力量", Agility: "敏捷",
    Intelligence: "智力", CombatRating: "战评",
  };
  const zh = (t) => SKILL_ZH[t] ?? t;

  function sessionOf(kind, s, cb) {
    const raw = s.startedAt ?? s.encounterId;
    if (raw == null || raw === "") { cb.key = null; return; }
    const t = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    cb.key = Number.isFinite(t) ? `${kind}:${t}` : `${kind}:${raw}`;
  }
  function combatOf(g) {
    const party = getPiniaStore("party");
    const pcs = party?.combatState;
    const who = getPiniaStore("character")?.activeCharacter?.id ?? null;
    if (pcs) {
      const cb = { party: true, state: pcs, who,
        zone: (g?.combatZones ?? []).find((z) => z.id === pcs.zoneId)
          ?? (party.dungeonCatalog ?? []).find((z) => z.id === pcs.zoneId),
        me: (pcs.players ?? []).find((p) => p.characterId === who) ?? null };
      sessionOf("party", pcs, cb);
      return cb;
    }
    const cs = g?.combatState;
    if (!cs) return null;
    const cb = { party: false, state: cs, who, me: cs.player ?? null,
      zone: (g.combatZones ?? []).find((z) => z.id === cs.zoneId) };
    sessionOf("solo", cs, cb);
    return cb;
  }
  const combatTitle = (cb) => cb.party
    ? `⚔ 组队·${cb.zone?.name ?? (cb.state.zoneName || "战斗中")}（${cb.state.killCount != null
      ? `击杀 ${cb.state.killCount}` : cb.state.waveNumber != null ? `波次 ${cb.state.waveNumber}` : "进行中"}）`
    : `⚔ ${cb.zone?.name ?? "战斗中"}（击杀 ${cb.state.killCount ?? 0}）`;
  function computeAlert(g, nowMs) {
    const cb = combatOf(g);
    if (!cb) return null;
    const hp = cb.me?.currentHp ?? cb.state.currentHp;
    const duRaw = cb.me?.deadUntil ?? cb.state.deadUntil;
    const du = duRaw ? new Date(duRaw).getTime() : null;
    if ((Number.isFinite(hp) && hp <= 0) || (du != null && du > nowMs) || cb.me?.isDead === true)
      return { reviveIn: du != null ? Math.max(0, (du - nowMs) / 1000) : null, party: cb.party };
    return null;
  }

  const MAX_GAP_MS = 120_000;
  const GOLD_WARMUP_MS = 30_000;
  const POTION_KEEP = 8;
  const POTION_STAT_LS = "fishidle-hud.potionStat";
  const POTION_LOW_LS = "fishidle-hud.potionLow";
  const potionLowOf = (v) => (Number.isFinite(v) ? Math.min(1440, Math.max(0, Math.round(v))) : 10);
  let potionLowMin = 10;
  try { potionLowMin = potionLowOf(+(localStorage.getItem(POTION_LOW_LS) ?? 10)); } catch {}
  const potionStat = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(POTION_STAT_LS) || "{}")))
      if (v && Number.isFinite(v.interval) && v.interval >= 0) potionStat.set(+k, { name: String(v.name ?? ""), interval: v.interval });
  } catch {}
  const persistPotionStat = () => { try { localStorage.setItem(POTION_STAT_LS, JSON.stringify(Object.fromEntries(potionStat))); } catch {} };
  const RUN_STATE_SS = "fishidle-hud.combatRun";
  const combatRun = { lastAt: 0, activeMs: 0, prevGold: null, loot: 0, key: null, who: null, savedAt: 0, potions: null, uses: new Map() };
  try {
    const s = JSON.parse(sessionStorage.getItem(RUN_STATE_SS) || "null");
    const legacy = s && s.goldBase != null && s.lootBase == null;
    if (s && !legacy && Number.isFinite(s.lastAt) && s.lastAt > 0) {
      combatRun.lastAt = s.lastAt; combatRun.activeMs = Math.max(0, s.activeMs || 0);
      combatRun.prevGold = Number.isFinite(s.prevGold) ? s.prevGold : null;
      combatRun.loot = Math.max(0, s.loot || 0);
      combatRun.key = typeof s.key === "string" ? s.key : null; combatRun.who = s.who ?? null;
    }
  } catch {}
  function saveCombatRun() {
    const r = combatRun;
    try { sessionStorage.setItem(RUN_STATE_SS, JSON.stringify({ key: r.key, who: r.who, prevGold: r.prevGold, loot: r.loot, activeMs: r.activeMs, lastAt: r.lastAt })); } catch {}
  }
  addEventListener("pagehide", () => { if (combatRun.key != null) saveCombatRun(); });
  document.addEventListener("freeze", () => { if (combatRun.key != null) saveCombatRun(); });
  const goldOf = (g) => (g.currencies ?? []).find((c) => c.currencyType === "Gold")?.amount ?? null;
  const fixed1 = (x) => x.toFixed(1).replace(/\.0$/, "");
  const fmtCompact = (n) => n >= 1e9 ? fixed1(n / 1e9) + "B" : n >= 1e6 ? fixed1(n / 1e6) + "M"
    : n >= 1e4 ? fixed1(n / 1e3) + "K" : String(Math.round(n));

  function stepCombatRun(g, cb, now) {
    const r = combatRun;
    if (!cb) {
      const idle = goldOf(g); if (idle != null) r.prevGold = idle;
      return;
    }
    const settling = !document.hidden || keepAlive.on;
    if (cb.who != null && r.who != null && cb.who !== r.who) r.key = null;
    r.who = cb.who ?? r.who;
    if (cb.key !== r.key) {
      r.activeMs = 0; r.loot = 0; r.prevGold = null; r.key = cb.key; r.lastAt = now;
    }
    const dt = now - r.lastAt;
    if (settling && dt > 0 && dt <= MAX_GAP_MS) r.activeMs += dt;
    r.lastAt = now;
    if (cb.party) {
      const gold = goldOf(g);
      if (gold != null) {
        if (r.prevGold != null) { const d = gold - r.prevGold; if (d > 0) r.loot += d; }
        r.prevGold = gold;
      }
    } else {
      r.loot = Number(cb.state.lootGold) || 0;
      const started = cb.state.startedAt ? Date.parse(cb.state.startedAt) : NaN;
      if (Number.isFinite(started)) r.activeMs = Math.max(0, now - started);
    }
    const pots = new Map();
    for (const it of g.inventory ?? []) if (/^Potion/.test(it.category ?? "") && Number.isFinite(it.quantity))
      pots.set(it.itemId, (pots.get(it.itemId) ?? 0) + it.quantity);
    if (r.potions) for (const [id, prev] of r.potions)
      if ((pots.get(id) ?? 0) === prev - 1) notePotionUse(id, g.inventory, now);
    r.potions = pots;
    if (now - r.savedAt >= 5000) { r.savedAt = now; saveCombatRun(); }
  }
  function notePotionUse(id, inventory, now) {
    let times = combatRun.uses.get(id);
    if (!times) combatRun.uses.set(id, times = []);
    if (times.at(-1) === now) return;
    times.push(now);
    if (times.length > POTION_KEEP) times.shift();
    const st = potionStat.get(id) ?? potionStat.set(id, { name: "", interval: 0 }).get(id);
    if (!st.name) st.name = (inventory ?? []).find((it) => it.itemId === id)?.name ?? `#${id}`;
    if (times.length < 2) return;
    const fresh = (times.at(-1) - times[0]) / (times.length - 1) / 1000;
    st.interval = st.interval > 0 ? st.interval * 0.6 + fresh * 0.4 : fresh;
    persistPotionStat();
  }
  function combatMonitorRows() {
    const r = combatRun, rows = [];
    const warm = r.activeMs >= GOLD_WARMUP_MS;
    rows.push({ label: "分均金币", value: `${warm ? fmtCompact(r.loot / (r.activeMs / 60000)) + "/分" : "统计中…"} · 本场 +${fmtCompact(r.loot)}`, accent: warm });
    for (const [id, times] of r.uses) {
      const qty = r.potions?.get(id) ?? 0, st = potionStat.get(id);
      const fresh = times.length >= 2 && times.at(-1) > times[0] ? (times.at(-1) - times[0]) / (times.length - 1) / 1000 : null;
      const interval = fresh ?? (st.interval > 0 ? st.interval : null), eta = qty * interval;
      if (qty > 0 && interval == null) continue;
      rows.push({ label: st.name, value: qty <= 0 ? "已耗尽" : `余 ${qty} · 耗尽 ${fmtDur(eta)}${fresh == null ? "（估）" : ""}`,
        accent: qty <= 0 || (interval != null && eta < potionLowMin * 60), accentColor: qty <= 0 ? "#f87171" : "#e8b45a" });
    }
    return rows;
  }

  const lodgeCalc = { hub: null, tried: false, state: null, rows: [] };
  function lodgeTap() {
    if (lodgeCalc.tried) return;
    lodgeCalc.tried = true;
    try {
      const url = [...new Set(performance.getEntriesByType("resource").map((e) => e.name))]
        .find((u) => /\/hubManager-[A-Za-z0-9_-]+\.js$/.test(u));
      if (!url) return;
      import(url).then((mod) => {
        const hub = Object.values(mod).find((m) => m && typeof m.getLodgeState === "function" && typeof m.onLodgeState === "function");
        if (!hub) return;
        lodgeCalc.hub = hub;
        hub.onLodgeState((state) => { lodgeCalc.state = state; renderLodgeGaps(); });
      }).catch(() => {});
    } catch {}
  }
  function lodgeAsk() {
    if (lodgeCalc.hub && !lodgeCalc.asked) { lodgeCalc.asked = true; try { lodgeCalc.hub.getLodgeState(); } catch {} }
  }
  const lodgeNum = (s) => { const m = String(s).match(/([\d.]+)([KMB])?/); return m ? Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1)) : NaN; };
  function lodgeRows() {
    const rows = [...document.querySelectorAll(".lodge-panel .block-costs .cost-row")];
    if (!rows.length) return null;
    lodgeTap(); lodgeAsk();
    const st = lodgeCalc.state;
    let pack = null;
    if (st) {
      const facility = document.querySelector(".lodge-content .block--facility")
        ? [...document.querySelectorAll(".lodge-panel .side-card--facility.active use")]
          .map((u) => (u.getAttribute("href") ?? "").match(/svg-icon:([A-Za-z]+)/)?.[1]).find(Boolean) : null;
      if (!facility && st.nextLodgeUpgrade) pack = st.nextLodgeUpgrade;
      else for (const f of [...(st.facilities ?? []), ...(st.buildableFacilities ?? [])])
        if (f.facilityType === facility && f.nextUpgrade) { pack = f.nextUpgrade; break; }
    }
    const gold = goldOf(getGameStore());
    const inv = new Map();
    for (const it of getGameStore()?.inventory ?? []) if ((it.enhancementLevel ?? 0) === 0) inv.set(it.itemId, (inv.get(it.itemId) ?? 0) + (it.quantity ?? 0));
    return rows.map((row, i) => {
      const num = (s) => { const m = String(s).match(/([\d.]+)([KMB])?/); return m ? Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1)) : NaN; };
      const [dep, req] = (row.querySelector(".cost-progress")?.textContent ?? "").split("/").map((x) => num(x));
      const owned = num((row.querySelector(".cost-owned")?.textContent ?? "").replace(/[^\d.KMB]/g, ""));
      const mat = pack?.materials?.[i - 1];
      const exact = i > 0 && mat ? { req: mat.required, dep: mat.deposited, owned: inv.get(mat.itemId) ?? 0 }
        : i === 0 ? { req: pack?.goldCost, dep: pack?.goldDeposited, owned: gold } : null;
      const use = (exact, dom) => (Number.isFinite(exact) ? exact : Number.isFinite(dom) ? dom : NaN);
      const required = use(exact?.req, req), deposited = use(exact?.dep, dep);
      const own = i === 0 ? (Number.isFinite(gold) ? gold : owned) : use(exact?.owned, owned);
      return { name: (row.querySelector(".cost-name")?.textContent ?? "").trim(),
        gap: Math.max(0, Math.round(required - deposited - own) || 0),
        approx: !Number.isFinite(required) || !Number.isFinite(deposited), itemId: mat?.itemId ?? null };
    });
  }
  function renderLodgeGaps() {
    if (!modules.lodge) return;
    const rows = document.querySelectorAll(".lodge-panel .block-costs .cost-row");
    if (!rows.length) return;
    lodgeCalc.rows = lodgeRows() ?? [];
    lodgeAsk();
    rows.forEach((row, i) => {
      const info = lodgeCalc.rows[i], meta = row.querySelector(".cost-meta");
      if (!info || !meta) return;
      let el = meta.querySelector(".fh-lodge-gap");
      if (!el) { el = document.createElement("span"); el.className = "fh-lodge-gap"; el.style.cssText = "font-weight:700;white-space:nowrap;"; meta.appendChild(el); }
      el.textContent = info.gap > 0 ? `还差 ${info.approx ? "≈" : ""}${fmtCompact(info.gap)}` : "已备齐";
      el.style.color = info.gap > 0 ? "#e8b45a" : "#7fd4a0";
    });
  }
  const KA_LS = "fishidle-hud.keepalive";
  const keepAlive = {
    on: (() => { try { return localStorage.getItem(KA_LS) === "1"; } catch { return false; } })(),
    installed: false,
  };
  const wrappedVis = new Map();
  function withSpoofedVisibility(fn) {
    const props = [["hidden", false], ["visibilityState", "visible"]];
    try {
      for (const [p, v] of props) Object.defineProperty(document, p, { get: () => v, configurable: true });
      return fn();
    } finally {
      for (const [p] of props) { try { delete document[p]; } catch {} }
    }
  }
  function installVisibilityInterceptor() {
    if (keepAlive.installed) return;
    keepAlive.installed = true;
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    document.addEventListener = function (type, listener, options) {
      if (type === "visibilitychange" && typeof listener === "function") {
        const wrapped = function (...args) {
          if (!keepAlive.on || !document.hidden) return listener.apply(this, args);
          return withSpoofedVisibility(() => listener.apply(this, args));
        };
        wrappedVis.set(listener, wrapped);
        return origAdd(type, wrapped, options);
      }
      return origAdd(type, listener, options);
    };
    document.removeEventListener = function (type, listener, options) {
      if (type === "visibilitychange" && wrappedVis.has(listener)) {
        const w = wrappedVis.get(listener);
        wrappedVis.delete(listener);
        return origRemove(type, w, options);
      }
      return origRemove(type, listener, options);
    };
  }
  installVisibilityInterceptor();
  function reportVisibility() {
    try { document.dispatchEvent(new Event("visibilitychange")); } catch {}
  }
  function enableKeepAlive() { reportVisibility(); }
  function disableKeepAlive() { reportVisibility(); }
  const EMPTY_MAP = new Map();
  let pipError = null;

  function buildModel() {
    const g = getGameStore();
    if (!g) return { status: "等待游戏加载…", sections: [], empty: null, alert: null };
    hookStore(g);
    const now = Date.now();
    const cb = combatOf(g);
    stepCombatRun(g, cb, now);
    const cs = String(g.connectionStatus ?? "").toLowerCase();
    let status = cs && cs !== "connected"
      ? `⚠ 连接: ${g.connectionStatus}`
      : (document.hidden ? (keepAlive.on ? "⏸ 后台（保持活跃中）" : "⏸ 页面处于后台") : "");
    if (pipError && now < pipError.until) status = (status ? status + " · " : "") + `📌 ${pipError.text}`;
    const parts = [];
    const alert = computeAlert(g, now);

    const cur = g.currentActivity;
    const q = g.activityQueue ?? [];
    const skillTick = new Map();
    for (const s of g.skills ?? []) if (Number.isFinite(s.tickIntervalSeconds) && s.tickIntervalSeconds > 0)
      skillTick.set(s.skillType, s.tickIntervalSeconds);
    const needCraft = isCraftingActivity(cur)
      || q.some((e) => e?.type === "Crafting" && e.craftingRecipeId != null);
    const recipes = needCraft ? new Map((g.craftingRecipes ?? []).map((r) => [r.id, r])) : EMPTY_MAP;
    const inv = needCraft ? new Map((g.inventory ?? []).map((it) => [it.itemId, it.quantity ?? 0])) : EMPTY_MAP;
    const ctx = { skillTick, recipes, inv, nowMs: now };

    const craftCtx = computeCraftCtx(cur, recipes, inv, skillTick);
    {
      const rows = [];
      if (cur) {
        const eta = tickEta(cur, ctx);
        const label = activityLabel(cur, g);
        rows.push({ label: "活动", value: label, accent: true });
        if (craftCtx) {
          rows.push({ label: "预计完成", value: craftCtx.short
            ? `缺料（仅够 ${craftCtx.actual} 次）` : "≈ " + fmtClock(craftCtx.eta), accent: !craftCtx.short });
          rows.push({ label: "剩余（实际）", value: (craftCtx.planned === 0 || craftCtx.planned == null)
            ? `${craftCtx.actual} 次（∞，料尽为止）`
            : craftCtx.short ? `${craftCtx.actual}/${craftCtx.planned} 次` : `${craftCtx.actual} 次` });
        } else {
          rows.push({ label: "预计完成", value: etaVal(eta, true) });
          if (Number.isFinite(cur.remainingTicks))
            rows.push({ label: "剩余", value: `${cur.remainingTicks} tick × ${(cur.tickIntervalSeconds ?? 0).toFixed(1)}s` });
          else if (cur.remainingCount === 0)
            rows.push({ label: "剩余", value: "∞ 无限" });
          else if (Number.isFinite(cur.remainingCount))
            rows.push({ label: "剩余", value: `${cur.remainingCount} 次` });
        }
      }
      if (cb) rows.push({ label: "战斗", value: combatTitle(cb), accent: true });
      else if (!cur) rows.push({ label: "状态", value: "空闲" });
      if (cb) for (const row of combatMonitorRows()) rows.push(row);
      parts.push({ title: "当前", rows });
    }

    if (q.length || g.queueLoopEnabled) {
      let total = 0, known = 0, hasInf = false;
      const rows = q.map((e, i) => {
        const eta = tickEta(e, ctx);
        if (eta?.sec != null && !eta.short) { total += eta.sec; known++; }
        if (eta?.inf) hasInf = true;
        const name = activityLabel(e, g);
        const value = isEnhancementActivity(e)
          ? `Lv.${e.enhancementCurrentLevel ?? "?"}→${e.enhancementGoalLevel ?? "?"}` : etaVal(eta, false);
        return { label: `${i + 1}. ${name}`, value, accent: i === 0 && !!eta && !eta.est && !eta.inf && !eta.short };
      });
      const sumTxt = known ? (known < q.length ? "≥ " : "") + fmtDur(total) : (hasInf ? "" : "—");
      rows.push({ label: `合计（${q.length}/${g.maxQueueSlots ?? "?"}）`, value: sumTxt + (hasInf ? "＋∞" : "") });
      if (g.queueLoopEnabled) rows.push({ label: "循环模式", value: "开启" });
      parts.push({ title: cb ? "队列（战斗结束后执行）" : "队列", rows });
    }

    const curSkill = (isEnhancementActivity(cur) || isAlchemyActivity(cur)) ? null
      : (cur ? (cur.skillType ?? cur.craftingProfession ?? null) : null);
    const inCombat = !!cb;
    const upRows = [];
    for (const key of ["skills", "combatSkills"]) {
      for (const s of g[key] ?? []) {
        const ty = s.skillType ?? s.combatSkillType;
        if (!ty || !(s.nextLevelExp > 0)) continue;
        const k = `${key}:${ty}`;
        track(k, s.experience, now);
        if (curSkill) { if (ty !== curSkill) continue; }
        else if (inCombat) { if (key !== "combatSkills") continue; }
        else continue;
        const r = rateOf(k, now);
        if (!r) {
          if (curSkill && ty === curSkill)
            upRows.push({ label: `${zh(ty)} Lv.${s.level}（${s.experience}/${s.nextLevelExp}）`, value: "采样中…" });
          continue;
        }
        const stale = now - r.lastChange > RATE_FRESH_MS;
        upRows.push({
          label: `${zh(ty)} Lv.${s.level}（${(r.xpPerSec * 60).toFixed(1)} xp/分${stale ? "，估" : ""}）`,
          value: fmtClock((s.nextLevelExp - s.experience) / r.xpPerSec),
          accent: !stale, stale,
        });
      }
    }
    let skipSampled = false;
    if (craftCtx) {
      const cx = craftXp.get(cur.craftingProfession);
      const rows = [];
      if (cx) {
        const crafts = Math.max(0, Math.ceil((cx.next - cx.xp) / craftCtx.r.xpPerCraft));
        rows.push(
          { label: `${zh(cur.craftingProfession)} Lv.${cx.lv}${craftCtx.r.craftedItemName ? `（${craftCtx.r.craftedItemName}）` : ""}`,
            value: `${cx.xp}/${cx.next} xp` },
          { label: "升级所需次数", value: `${crafts} 次` },
          { label: "单次时间", value: `${(+craftCtx.timePerCraft).toFixed(1)} 秒` },
          { label: "升级时间", value: fmtClock(crafts * craftCtx.timePerCraft), accent: true },
        );
      }
      if (craftCtx.mats.length) {
        rows.push({ label: "材料（每次）",
          value: craftCtx.mats.map((m) => `${m.name} ×${m.per}`).join("、") });
        rows.push({ label: "背包剩余",
          value: craftCtx.mats.map((m) => `${m.name} ${m.have}`).join("、") });
      }
      rows.push({ label: "实际剩余次数", value: craftCtx.short
        ? `${craftCtx.actual}/${craftCtx.planned} 次（缺料）`
        : (craftCtx.planned === 0 || craftCtx.planned == null) ? `${craftCtx.actual} 次（∞，料尽为止）` : `${craftCtx.actual} 次` });
      if (craftCtx.mats.length)
        rows.push({ label: craftCtx.short ? "缺料停止时间" : "料尽/完成时间",
          value: "≈ " + fmtClock(craftCtx.eta), accent: !craftCtx.short });
      parts.push({ title: "生产预估", rows });
      skipSampled = true;
    }
    upRows.sort((a, b) => a.label.localeCompare(b.label));
    if (!skipSampled && upRows.length) parts.push({ title: "升级预估", rows: upRows });

    return { status, sections: parts, empty: parts.length ? null : "无活动/队列，无技能在训练", alert };
  }

  const root = document.createElement("div");
  root.id = "fishidle-hud";
  root.innerHTML = `
    <style>@keyframes fhblink{from{opacity:1}to{opacity:.55}}</style>
    <div id="fh-head" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:move;
         border-bottom:1px solid rgba(120,160,255,.18);">
      <span style="font-weight:600;letter-spacing:.5px;">🎣 FishIdle HUD</span>
      <span id="fh-status" style="font-size:10px;opacity:.6;color:#e8b45a;"></span>
      <span style="flex:1"></span>
      <button id="fh-pip" title="置顶小窗（无网址栏，浏览器最小化仍可见）"
        style="all:unset;cursor:pointer;padding:0 4px;opacity:.7;font-size:13px;">📌</button>
      <button id="fh-ka" title="保持活跃"
        style="all:unset;cursor:pointer;padding:0 4px;opacity:.45;font-size:13px;">⚡</button>
      <button id="fh-min" title="收起/展开"
        style="all:unset;cursor:pointer;padding:0 4px;opacity:.7;font-size:14px;">—</button>
    </div>
    <div id="fh-body" style="padding:8px 10px 10px;"></div>`;
  root.style.cssText = `
    position:fixed; top:12px; right:12px; z-index:99999; min-width:270px; max-width:360px;
    background:rgba(16,20,28,.92); color:#dfe6f0; font:12px/1.55 system-ui,sans-serif;
    border:1px solid rgba(120,160,255,.25); border-radius:10px;
    box-shadow:0 6px 24px rgba(0,0,0,.45); backdrop-filter:blur(6px);
    user-select:none; overflow:hidden;`;
  const elBody = root.querySelector("#fh-body"), elStatus = root.querySelector("#fh-status");

  const alertText = (a) => a.reviveIn != null ? `☠ 已死亡（${fmtDur(a.reviveIn)} 后复活）` : "☠ 已死亡";

  const fhRow = (label, value, o = {}) =>
    `<div style="display:flex;justify-content:space-between;gap:${o.gap ?? 12}px;${o.stale ? "opacity:.55;" : ""}">
       <span style="opacity:${o.lo ?? ".75"};">${label}</span>
       <span style="${o.accent ? `color:${o.accentColor ?? "#7fd4a0"};${o.bold ? "font-weight:600;" : ""}` : ""}font-variant-numeric:tabular-nums;">${value}</span>
     </div>`;

  let lastBodyHtml = null, lastStatus = null;
  function renderDom(m) {
    if (m.status !== lastStatus) { elStatus.textContent = m.status; lastStatus = m.status; }
    const banner = m.alert
      ? `<div style="margin:2px 0 6px;padding:6px 10px;border-radius:6px;font-weight:700;
           background:#7f1d1d;color:#fecaca;text-align:center;animation:fhblink 1s infinite alternate;">
           ${alertText(m.alert)}</div>` : "";
    const secHtml = (s) =>
      `<div style="margin:7px 0 2px;font-size:10px;letter-spacing:1px;opacity:.5;">${s.title}</div>` +
      s.rows.map((r) => fhRow(r.label, r.value, r)).join("");
    const html = banner + (m.empty
      ? `<div style="opacity:.5;">${m.empty}</div>`
      : m.sections.map(secHtml).join(""));
    if (html !== lastBodyHtml) { elBody.innerHTML = html; lastBodyHtml = html; }
  }
  let wasDead = false, deadEpisode = false, aliveSince = 0;
  const baseTitle = document.title || "FishIdle";
  function runAlertEffects(m, now) {
    if (m.alert) { deadEpisode = true; aliveSince = 0; }
    else if (deadEpisode) {
      if (!aliveSince) aliveSince = now;
      if (now - aliveSince > 3000) deadEpisode = false;
    }
    const eff = m.alert || deadEpisode;
    if (eff) document.title = "☠ FishIdle 死亡告警";
    else if (wasDead) document.title = baseTitle;
    wasDead = eff;
  }

  const PIP_SCALE = 2, PIP_W = 340;
  let pipVideo = null, pipCanvas = null, pipCtx = null, pipStream = null;
  async function togglePip() {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    try {
      pipCanvas = document.createElement("canvas");
      pipCanvas.width = PIP_W * PIP_SCALE; pipCanvas.height = 200 * PIP_SCALE;
      pipStream = pipCanvas.captureStream(2);
      pipCtx = pipCanvas.getContext("2d");
      pipVideo = document.createElement("video");
      pipVideo.muted = true; pipVideo.playsInline = true; pipVideo.autoplay = true;
      pipVideo.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;";
      pipVideo.srcObject = pipStream;
      pipVideo.addEventListener("leavepictureinpicture", cleanupPip);
      document.body.appendChild(pipVideo);
      drawPip(buildModel());
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
      root.querySelector("#fh-pip").textContent = "↩";
    } catch (e) {
      cleanupPip();
      pipError = { text: "置顶失败: " + (e.message || e.name), until: Date.now() + 5000 };
    }
  }
  function cleanupPip() {
    pipStream?.getTracks().forEach((t) => t.stop());
    pipVideo?.remove();
    pipStream = pipVideo = pipCanvas = pipCtx = null;
    root.querySelector("#fh-pip").textContent = "📌";
  }
  root.querySelector("#fh-pip").addEventListener("click", togglePip);
  const elKa = root.querySelector("#fh-ka");
  function syncKaBtn() {
    const active = keepAlive.on;
    elKa.style.opacity = active ? "1" : ".45";
    elKa.style.color = active ? "#7fd4a0" : "";
    elKa.title = active
      ? "保持活跃：开（后台时仅对服务器报可见，战斗/生产照常结算，点击关闭）"
      : "保持活跃：关（后台时服务器暂停结算，点击开启）";
  }
  elKa.addEventListener("click", () => {
    keepAlive.on = !keepAlive.on;
    try { localStorage.setItem(KA_LS, keepAlive.on ? "1" : "0"); } catch {}
    if (keepAlive.on) enableKeepAlive(); else disableKeepAlive();
    syncKaBtn();
    probe();
  });
  syncKaBtn();

  function renderPip(m) {
    if (!pipCtx || !document.pictureInPictureElement) return;
    drawPip(m);
  }
  function drawPip(m) {
    if (!pipCtx) return;
    const W = PIP_W, PAD = 12, LH = 20;
    const lines = [{ text: "🎣 FishIdle HUD" + (m.status ? `  ${m.status}` : ""),
      font: "600 13px system-ui", color: "#dfe6f0", title: true }];
    if (m.alert) lines.push({ banner: alertText(m.alert) });
    if (m.empty) lines.push({ text: m.empty, font: "12px system-ui", color: "rgba(223,230,240,.5)" });
    for (const s of m.sections) {
      lines.push({ text: s.title, font: "10px system-ui", color: "rgba(223,230,240,.45)", gap: 8 });
      for (const r of s.rows) lines.push({ text: r.label, value: r.value, font: "12px system-ui",
        color: r.stale ? "rgba(223,230,240,.5)" : "rgba(223,230,240,.8)",
        vcolor: r.accent ? "#7fd4a0" : "#dfe6f0" });
    }
    const H = Math.min(640, 34 + lines.length * LH + PAD * 2 + 8);
    if (pipCanvas.height !== H * PIP_SCALE) pipCanvas.height = H * PIP_SCALE;
    const c = pipCtx;
    c.setTransform(PIP_SCALE, 0, 0, PIP_SCALE, 0, 0);
    c.fillStyle = "#10141c";
    c.fillRect(0, 0, W, H);
    let y = PAD + 4;
    for (const l of lines) {
      if (l.gap) y += l.gap;
      if (l.banner) {
        c.fillStyle = "#b91c1c";
        c.fillRect(PAD - 4, y, W - (PAD - 4) * 2, LH);
        c.fillStyle = "#fff";
        c.font = "700 12px system-ui";
        c.textBaseline = "middle";
        const tw = c.measureText(l.banner).width;
        c.fillText(l.banner, (W - tw) / 2, y + LH / 2);
        y += LH;
        continue;
      }
      c.font = l.font;
      c.fillStyle = l.color;
      c.textBaseline = "middle";
      c.fillText(l.text, PAD, y + LH / 2);
      if (l.value) {
        c.fillStyle = l.vcolor;
        const w = c.measureText(l.value).width;
        c.fillText(l.value, W - PAD - w, y + LH / 2);
      }
      y += LH;
    }
  }

  const FH_INFO_ID = "fh-craft-level-info";
  function enhanceStartDialog() {
    if (!modules.dialog) return;
    const dlg = document.querySelector('[role=dialog]');
    if (!dlg) return;
    const text = dlg.innerText?.replace(/\s+/g, " ") ?? "";
    if (!text.includes("重复次数")) {
      document.getElementById(FH_INFO_ID)?.remove();
      delete dlg.dataset.fhItem;
      return;
    }
    const gm = text.match(/开始采集\s*[×x]\s*([^\s]+)/);
    const am = text.match(/开始炼金\s*[×x]\s*([^\s]+)/);
    const m = gm ?? am ?? text.match(/开始(?!采集|战斗|炼金)[^×\s]*\s*[×x]\s*([^\s]+)/);
    if (!m) { document.getElementById(FH_INFO_ID)?.remove(); return; }
    const itemName = m[1];
    const isGather = !!gm, isAlchemy = !!am;
    const fhKey = (isGather ? "G:" : isAlchemy ? "A:" : "C:") + itemName;
    const anchor = [...dlg.querySelectorAll("button")].find((b) => b.innerText.trim() === "添加到队列")
      ?.closest("div:not(#" + FH_INFO_ID + ")");
    const repHost = [...dlg.querySelectorAll("div")]
      .filter((d) => !d.querySelector("div") && d.innerText.includes("重复次数") && d.innerText.length < 200)
      .pop() ?? null;
    const target = anchor ?? repHost;
    if (!target) return;
    const info = document.getElementById(FH_INFO_ID);
    if (dlg.dataset.fhItem === fhKey && info && info.nextElementSibling === target) return;
    dlg.dataset.fhItem = fhKey;
    info?.remove();

    const g = getGameStore();
    const recipe = !isGather && !isAlchemy ? (g?.craftingRecipes ?? []).find((r) => r.craftedItemName === itemName) : null;
    const resource = isGather ? (g?.resources ?? []).find((r) => r.name === itemName) : null;
    const ax = isAlchemy ? craftXp.get("Alchemy") : null;
    const cx = recipe && craftXp.get(recipe.profession);
    const host = document.createElement("div");
    host.id = FH_INFO_ID;
    host.style.cssText = `margin:8px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.7;
      background:rgba(120,160,255,.08);border:1px dashed rgba(120,160,255,.35);color:inherit;`;
    const dlgRow = (k, v, accent) => fhRow(k, v, { accent, accentColor: "#4ade80", bold: true, gap: 16, lo: ".7" });
    if (isGather && !resource) {
      host.innerHTML = dlgRow("FishIdle HUD", "未找到资源数据");
    } else if (isGather) {
      const st = resource.skillType;
      const sk = (g?.skills ?? []).find((s) => s.skillType === st);
      const gx = gatherXp.get(st + "|" + resource.id);
      if (!sk || !(sk.nextLevelExp > 0)) host.innerHTML = dlgRow("FishIdle HUD", "未找到技能数据");
      else {
        const per = gx?.per > 0 ? gx.per : gatherXpPer(resource.tier, sk.level);
        const t = Number.isFinite(gx?.tick) && gx.tick > 0 ? gx.tick
          : gatherInterval(resource.tier, sk.level, gatherToolTier(g, st));
        const times = Math.max(0, Math.ceil((sk.nextLevelExp - sk.experience) / per));
        host.innerHTML =
          dlgRow(`升级所需次数（${zh(st)} Lv.${sk.level}，${sk.experience}/${sk.nextLevelExp} xp，每次 +${per}）`, `${times} 次`, true) +
          dlgRow("升级预计时间（单次 ≈ " + (+t).toFixed(1) + " 秒）", "≈ " + fmtDur(times * t), true);
      }
    } else if (isAlchemy) {
      host.innerHTML = ax
        ? dlgRow(`炼金 Lv.${ax.lv ?? "?"}（${ax.xp}/${ax.next} xp）`, "单次经验待采样", true)
        : dlgRow("炼金升级预估", "先生产一次以采样经验数据");
    } else if (!recipe) {
      host.innerHTML = dlgRow("FishIdle HUD", "未找到配方数据");
    } else if (!cx || !Number.isFinite(cx.next) || !Number.isFinite(cx.xp) || !(recipe.xpPerCraft > 0)) {
      host.innerHTML = dlgRow("升级预估", "本次会话未生产过该职业，暂无经验数据");
    } else {
      const t = Number.isFinite(recipe.baseTickIntervalSeconds) ? recipe.baseTickIntervalSeconds : null;
      const crafts = Math.max(0, Math.ceil((cx.next - cx.xp) / recipe.xpPerCraft));
      host.innerHTML =
        dlgRow(`升级所需次数（${zh(recipe.profession)} Lv.${cx.lv}，${cx.xp}/${cx.next} xp）`, `${crafts} 次`, true) +
        (t ? dlgRow("升级预计时间（单次 ≈ " + (+t).toFixed(1) + " 秒）", "≈ " + fmtDur(crafts * t), true) : "");
    }
    if (modules.fav && (recipe || resource)) {
      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.style.cssText = `all:unset;cursor:pointer;display:block;width:100%;text-align:center;
        margin-top:6px;padding:4px 0;border-radius:6px;font-size:12px;
        background:rgba(250,204,21,.12);border:1px dashed rgba(250,204,21,.4);`;
      favBtn.textContent = "⭐ 收藏此项（记住当前次数）";
      favBtn.onclick = () => {
        const repText = [...dlg.querySelectorAll("div")].find((d) => d.innerText.includes("重复次数") && d.innerText.length < 200)?.innerText ?? "";
        const cm = repText.match(/重复次数\s*(\d+|∞|MAX)/);
        const count = !cm ? 1 : (cm[1] === "∞" ? 0 : cm[1] === "MAX" ? 0 : Math.max(0, parseInt(cm[1])));
        const favDef = resource
          ? { kind: "Gathering", id: resource.id, prof: resource.skillType }
          : { kind: "Crafting", id: recipe.id, prof: recipe.profession };
        const favs = loadFavs().filter((f) => f.id !== favDef.id || f.kind !== favDef.kind);
        favs.unshift({ ...favDef, name: itemName, count, ts: Date.now() });
        saveFavs(favs.slice(0, 12));
        favBtn.textContent = "✅ 已收藏（可在左侧 ⭐ 收藏栏快速开始）";
        favBtn.onclick = null;
      };
      host.appendChild(favBtn);
    }
    target.parentNode.insertBefore(host, target);
  }
  const inHudTree = (n) => n === root || root.contains(n)
    || (favPage?.contains(n) ?? false) || (calcPage?.contains(n) ?? false);
  let navInstallAt = 0;
  const hudObserver = new MutationObserver((muts) => {
    if (muts.every((mu) => inHudTree(mu.target))) return;
    try { enhanceStartDialog(); } catch {}
    const now = Date.now();
    if (now - navInstallAt >= 250) {
      navInstallAt = now;
      try { installFavNav(); installCalcNav(); installSettingsTab(); if (settingsTabOn) setSettingsTab(true); } catch {}
    }
  });

  const FAV_LS = "fishidle-hud.favorites";
  const loadFavs = () => {
    try {
      return JSON.parse(localStorage.getItem(FAV_LS) || "[]")
        .filter((f) => f && f.id != null && f.prof != null)
        .map((f) => ({ kind: "Crafting", ...f }));
    } catch { return []; }
  };
  const saveFavs = (f) => { try { localStorage.setItem(FAV_LS, JSON.stringify(f)); } catch {} };
  function favStart(fav, toQueue) {
    const g = getGameStore();
    if (!g) return;
    try {
      if (fav.kind === "Gathering") {
        const r = (g.resources ?? []).find((x) => x.id === fav.id);
        if (!r) { console.warn("[FishIdle HUD] 收藏的资源不存在:", fav.name); return; }
        if (toQueue)
          g.addToQueue("Gathering", r.skillType, r.locationId ?? null, r.id, null, null, null, null, fav.count, null, null, null, null, null, null, null, false, 0);
        else
          g.startActivity(r.skillType, r.locationId ?? null, r.id, fav.count, "keep", 0);
      } else if (toQueue)
        g.addToQueue("Crafting", null, null, null, fav.prof, fav.id, null, null, fav.count, null, null, null, null, null, null, null, false, 0);
      else
        g.startCraftingActivity(fav.prof, fav.id, fav.count, "keep", null);
    } catch (e) { console.warn("[FishIdle HUD] 收藏启动失败:", e); }
  }
  let favPage = null, favPageNav = null;
  function hideFavPage() {
    favPage?.remove(); favPage = null;
    favPageNav?.classList.remove("active");
  }
  function favCardHtml(f, i, ctxInfo) {
    const { recipe, resource, gx, skill, possible, cx } = ctxInfo;
    const isGather = f.kind === "Gathering";
    const ready = possible == null || possible > 0;
    const meta = isGather
      ? (() => {
          const per = gx?.per > 0 ? gx.per
            : (resource && skill ? gatherXpPer(resource.tier, skill.level) : null);
          const tick = Number.isFinite(gx?.tick) && gx.tick > 0 ? gx.tick
            : (resource && skill ? gatherInterval(resource.tier, skill.level, gatherToolTier(getGameStore(), f.prof)) : null);
          return [
            resource?.baseYield ? `产出 ×${resource.baseYield}（${resource.yieldMin ?? "?"}-${resource.yieldMax ?? "?"}）` : "",
            per ? `经验 +${per}` : "",
            tick ? `${(+tick).toFixed(1)}秒/次` : "",
          ].filter(Boolean).join(" · ");
        })()
      : [
          recipe ? `产出 ×${recipe.resultQuantity ?? 1}` : "",
          recipe?.xpPerCraft ? `经验 +${recipe.xpPerCraft}` : "",
          recipe?.baseTickIntervalSeconds ? `${(+recipe.baseTickIntervalSeconds).toFixed(1)}秒/次` : "",
          recipe?.ingredients?.length ? recipe.ingredients.map((m) => `${m.name} ×${m.quantity}`).join("、") : "",
        ].filter(Boolean).join(" · ");
    const craftable = isGather
      ? (ready ? "" : `技能等级不足（需 Lv.${resource?.unlockLevel ?? "?"}）`)
      : (possible == null ? "" : possible > 0
        ? `可制作 ${Math.min(f.count || possible, possible)} 次` : "材料不足");
    const lv = isGather ? skill?.level : cx?.lv;
    const lvInfo = lv != null ? `${zh(f.prof)} Lv.${lv}` : zh(f.prof);
    const tier = isGather ? resource?.tier : recipe?.craftedItemTier;
    const border = ready ? "rgba(127,224,184,.55)" : "rgba(150,150,150,.35)";
    const bg = ready ? "rgba(127,224,184,.05)" : "rgba(150,150,150,.04)";
    return `<button type="button" data-i="${i}"
        style="all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;cursor:default;text-align:left;
          padding:10px 12px;border-radius:10px;border:1px solid ${border};background:${bg};color:#e6edf3;
          font:13px/1.5 system-ui,sans-serif;transition:background .15s;"
        onmouseover="this.style.background='${ready ? "rgba(127,224,184,.12)" : "rgba(150,150,150,.08)"}'"
        onmouseout="this.style.background='${bg}'">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:600;">${f.name}</span>
        ${isGather ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgb(21,94,90);">采集</span>` : ""}
        ${tier ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgb(75,85,99);">T${tier}</span>` : ""}
        <span style="opacity:.6;font-size:11px;">${lvInfo} · 计划 ×${f.count === 0 ? "∞" : f.count}</span>
        <span style="flex:1"></span>
        <span data-act="start" title="立即开始（原活动按游戏机制处理）"
          style="cursor:pointer;padding:2px 10px;border-radius:5px;background:#1d4ed8;color:#fff;font-size:12px;">▶ 开始</span>
        <span data-act="queue" title="添加到队列"
          style="cursor:pointer;padding:2px 10px;border-radius:5px;background:#374151;color:#fff;font-size:12px;">＋ 入队</span>
        <span data-act="del" title="移除收藏"
          style="cursor:pointer;opacity:.55;font-size:13px;padding:0 4px;">✕</span>
      </div>
      <div style="font-size:11px;opacity:.75;">${meta}</div>
      ${craftable ? `<div style="font-size:11px;${ready ? "color:#7fe0b8;" : "opacity:.7;"}">${craftable}</div>` : ""}
    </button>`;
  }
  function renderFavPage() {
    if (!favPage) return;
    const scrollTop = favPage.scrollTop;
    const g = getGameStore();
    const favs = loadFavs();
    const recipes = new Map((g?.craftingRecipes ?? []).map((r) => [r.id, r]));
    const resources = new Map((g?.resources ?? []).map((r) => [r.id, r]));
    const inv = new Map((g?.inventory ?? []).map((it) => [it.itemId, it.quantity ?? 0]));
    favPage.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <b style="font-size:14px;">⭐ 收藏</b>
        <span style="opacity:.55;font-size:12px;">${favs.length} 项 · 在"开始制造/采集"对话框点 ⭐ 添加</span>
        <span style="flex:1"></span>
        <span id="fh-fav-close" title="关闭" style="cursor:pointer;opacity:.6;font-size:14px;">✕</span>
      </div>` +
      (favs.length
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:10px;">` +
          favs.map((f, i) => {
            if (f.kind === "Gathering") {
              const resource = resources.get(f.id) ?? null;
              const skill = (g?.skills ?? []).find((s) => s.skillType === f.prof) ?? null;
              const gx = resource ? gatherXp.get(f.prof + "|" + resource.id) : null;
              const possible = resource && skill ? (skill.level >= resource.unlockLevel ? 1 : 0) : null;
              return favCardHtml(f, i, { resource, gx, skill, possible });
            }
            const recipe = recipes.get(f.id) ?? null;
            let possible = null;
            if (recipe?.ingredients?.length)
              possible = Math.min(...recipe.ingredients.map((m) => Math.floor((inv.get(m.itemId) ?? 0) / (m.quantity || 1))));
            return favCardHtml(f, i, { recipe, possible, cx: craftXp.get(f.prof) });
          }).join("") + `</div>`
        : `<div style="opacity:.55;padding:40px 0;text-align:center;">暂无收藏——打开任意制造配方或采集资源，在"开始"对话框里点 ⭐ 收藏此项。</div>`);
    favPage.scrollTop = scrollTop;
    for (const el of favPage.querySelectorAll("[data-act]")) {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const i = +el.closest("[data-i]")?.dataset.i, favs2 = loadFavs(), f = favs2[i];
        if (!f) return;
        if (el.dataset.act === "del") { favs2.splice(i, 1); saveFavs(favs2); renderFavPage(); }
        else favStart(f, el.dataset.act === "queue");
      };
    }
  }
  function createOverlayPanel(id) {
    const el = document.createElement("div");
    el.id = id;
    el.style.cssText = `position:fixed;z-index:9998;overflow-y:auto;padding:14px;
      background:rgba(13,17,24,.97);color:#e6edf3;font:13px/1.55 system-ui,sans-serif;
      border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(4px);`;
    document.body.appendChild(el);
    return el;
  }
  function syncPanelPos(el) {
    if (!el?.isConnected) return;
    const host = document.querySelector(".center-content") ?? document.querySelector("main.game-layout__main");
    if (!host) return;
    const r = host.getBoundingClientRect();
    Object.assign(el.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }
  function toggleFavPage() {
    if (calcPage) hideCalcPage();
    if (favPage) return hideFavPage();
    favPage = createOverlayPanel("fh-fav-page");
    syncPanelPos(favPage);
    renderFavPage();
    favPageNav?.classList.add("active");
  }
  document.addEventListener("click", (e) => {
    if (!favPage && !calcPage) return;
    const entry = e.target.closest?.(".skill-entry");
    if (entry && entry.id !== "fh-fav-nav" && entry.id !== "fh-calc-nav") { hideFavPage(); hideCalcPage(); }
  }, true);
  addEventListener("resize", () => { syncPanelPos(favPage); syncPanelPos(calcPage); });
  function installSidebarNav(id, icon, label, title, onClick, anchor) {
    if (document.getElementById(id) || !anchor?.parentNode) return null;
    const btn = document.createElement("button");
    btn.id = id; btn.type = "button"; btn.className = "skill-entry"; btn.title = title;
    const dv = anchor.getAttributeNames().find((n) => n.startsWith("data-v-"));
    if (dv) btn.setAttribute(dv, "");
    const top = document.createElement("div");
    top.className = "sk-top";
    if (dv) top.setAttribute(dv, "");
    top.innerHTML = `<span class="sk-icon"${dv ? ` ${dv}=""` : ""}><span class="icon-root" style="font-size:22px;">${icon}</span></span>` +
      `<span class="sk-name"${dv ? ` ${dv}=""` : ""}>${label}</span>`;
    btn.appendChild(top);
    btn.onclick = (e) => { e.stopPropagation(); onClick(); };
    anchor.parentNode.insertBefore(btn, anchor);
    return btn;
  }
  function installFavNav() {
    if (!modules.fav) return;
    const btn = installSidebarNav("fh-fav-nav", "⭐", "收藏", "生产收藏（FishIdle HUD）",
      toggleFavPage, document.querySelector(".skill-entry--market"));
    if (btn) favPageNav = btn;
  }

  const CALC_TIERS = [1, 2, 3, 4, 5, 6, 7];
  const ARMOR_SLOTS = ["Head", "Chest", "Legs", "Hands", "Feet"];
  const ARMOR_TITLE = { Plate: "板甲", Leather: "套装", Cloth: "法袍" };
  const CLASS_SETS = [
    { id: "warrior", label: "战士", armor: "Plate", weapons: [["WeaponGreatsword", 1]], hint: "巨剑 + 板甲五件。巨锤、巨斧的配料与巨剑相同。" },
    { id: "tank", label: "坦克", armor: "Plate", weapons: [["WeaponSword", 1], ["WeaponShield", 1]], hint: "战剑 + 盾 + 板甲五件。战锤、战斧的配料与战剑相同。" },
    { id: "ice", label: "冰", armor: "Cloth", weapons: [["WeaponWand", 1], ["OffhandTome", 1]], hint: "魔杖 + 魔典 + 布甲五件。T1–T7 与火法是同一条装备线。" },
    { id: "fire", label: "火法", armor: "Cloth", weapons: [["WeaponWand", 1], ["OffhandTome", 1]], hint: "魔杖 + 魔典 + 布甲五件。T1–T7 与冰是同一条装备线。" },
    { id: "priest", label: "牧师", armor: "Cloth", weapons: [["WeaponStaff", 1]], hint: "法杖 + 布甲五件。" },
    { id: "hunter", label: "猎人", armor: "Leather", weapons: [["WeaponBow", 1]], hint: "弓 + 皮甲五件。弩的配料与弓不同，未单列。" },
    { id: "thief", label: "盗贼", armor: "Leather", weapons: [["WeaponDagger", 2]], hint: "匕首 ×2 + 皮甲五件。" },
  ];
  const CLASS_LS = "fishidle-hud.calcClass";
  let calcClassId = (() => { try { return localStorage.getItem(CLASS_LS) ?? ""; } catch { return ""; } })();
  if (!CLASS_SETS.some((c) => c.id === calcClassId)) calcClassId = "thief";
  const calcClass = () => CLASS_SETS.find((c) => c.id === calcClassId);
  const commonPrefix = (names) => {
    let p = names[0] ?? "";
    for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
    return p;
  };
  function classTiers(cls) {
    const byCat = new Map((getGameStore()?.craftingRecipes ?? [])
      .map((r) => [r.craftedItemCategory + ":" + r.craftedItemTier, r.craftedItemName]));
    const pick = (cat, t) => byCat.get(cat + ":" + t);
    return CALC_TIERS.map((t) => {
      const armor = ARMOR_SLOTS.map((s) => pick("Armor" + cls.armor + s, t)).filter(Boolean);
      const weapons = cls.weapons.map(([cat, qty]) => [pick(cat, t), qty]).filter(([n]) => n);
      return { tier: t, title: `T${t} · ${commonPrefix(armor)}${ARMOR_TITLE[cls.armor]} + ${weapons.map(([n]) => n).join(" + ")}`,
        items: weapons.concat(armor.map((n) => [n, 1])) };
    }).filter((t) => t.items.length);
  }
  function selectCalcClass(id) {
    calcClassId = id;
    try { localStorage.setItem(CLASS_LS, id); } catch {}
    calcExpanded.clear(); calcBlockOpen.clear(); calcBlockInit = false;
    renderCalcPage();
    if (calcPage) calcPage.scrollTop = 0;
  }

  function selectCalcTotalTier(tier) {
    calcTotalTier = tier;
    try { localStorage.setItem(TIER_LS, String(tier)); } catch {}
    calcTotalOpen = true;
    renderCalcPage();
  }

  function computeMrp(goals) {
    const g = getGameStore();
    if (!g) return null;
    const byProduct = new Map((g.craftingRecipes ?? []).map((r) => [r.craftedItemName, r]));
    const have = new Map((g.inventory ?? []).map((i) => [i.name, i.quantity ?? 0]));
    for (const w of g.equippedWeapons ?? []) {
      const n = w?.itemName ?? w?.name;
      if (n) have.set(n, (have.get(n) ?? 0) + 1);
    }
    for (const a of g.equippedArmor ?? []) {
      const n = a?.itemName ?? a?.name;
      if (n) have.set(n, (have.get(n) ?? 0) + 1);
    }
    const reachable = new Set();
    const visit = (n) => {
      if (reachable.has(n)) return; reachable.add(n);
      for (const i of byProduct.get(n)?.ingredients ?? []) visit(i.name);
    };
    goals.forEach((gl) => visit(gl.name));
    const indeg = new Map([...reachable].map((n) => [n, 0]));
    for (const n of reachable) for (const ing of byProduct.get(n)?.ingredients ?? [])
      if (reachable.has(ing.name)) indeg.set(ing.name, indeg.get(ing.name) + 1);
    const order = [], kq = [...reachable].filter((n) => !indeg.get(n));
    while (kq.length) {
      const n = kq.shift();
      order.push(n);
      for (const ing of byProduct.get(n)?.ingredients ?? []) {
        if (!reachable.has(ing.name) || !indeg.get(ing.name)) continue;
        const v = indeg.get(ing.name) - 1;
        indeg.set(ing.name, v);
        if (v === 0) kq.push(ing.name);
      }
    }
    const gross = new Map();
    goals.forEach((gl) => gross.set(gl.name, (gross.get(gl.name) ?? 0) + gl.qty));
    const rows = [], inRows = new Set();
    for (const name of order) {
      const r = byProduct.get(name);
      const gr = gross.get(name) ?? 0, h = have.get(name) ?? 0;
      const net = Math.max(0, gr - h);
      if (r && net > 0) for (const ing of r.ingredients ?? [])
        gross.set(ing.name, (gross.get(ing.name) ?? 0) + net * ing.quantity);
      rows.push({ name, gross: gr, have: h, net, recipe: r ?? null });
      inRows.add(name);
    }
    for (const [name, gr] of gross) if (!byProduct.has(name) && !inRows.has(name))
      rows.push({ name, gross: gr, have: have.get(name) ?? 0, net: Math.max(0, gr - (have.get(name) ?? 0)), recipe: null });
    const mkNode = (name, qty, path) => {
      const r = byProduct.get(name);
      const children = [];
      if (r && !path.has(name)) {
        const np = new Set(path); np.add(name);
        for (const ing of r.ingredients ?? []) children.push(mkNode(ing.name, ing.quantity, np));
      }
      return { name, qty, recipe: r ?? null, children };
    };
    return { rows, makeTree: (name) => mkNode(name, null, new Set()) };
  }

  let calcPage = null, calcNav = null;
  function hideCalcPage() { calcPage?.remove(); calcPage = null; calcNav?.classList.remove("active"); }
  const calcExpanded = new Set();
  let calcBlockInit = false;
  const calcBlockOpen = new Set();
  let calcTotalOpen = false;
  const TIER_LS = "fishidle-hud.calcTier";
  let calcTotalTier = 0;
  try { const v = +localStorage.getItem(TIER_LS); if (CALC_TIERS.includes(v)) calcTotalTier = v; } catch {}
  function renderCalcPage() {
    if (!calcPage) return;
    const scrollTop = calcPage.scrollTop;
    const cls = calcClass(), tiers = classTiers(cls), last = tiers.at(-1);
    const mrp = last && computeMrp(last.items.map(([name, qty]) => ({ name, qty })));
    if (!mrp) { calcPage.innerHTML = getGameStore() ? "配方目录里没有这套装备的数据" : "等待游戏加载…"; return; }
    const rowBy = new Map(mrp.rows.map((r) => [r.name, r]));
    const gate = (recipe) => {
      if (!recipe) return "";
      const cur = craftXp.get(recipe.profession)?.lv ?? "?";
      const ok = typeof cur === "number" && cur >= recipe.requiredLevel;
      return `<span style="font-size:11px;color:${ok ? "#7fe0b8" : "#f87171"};">${zh(recipe.profession)} ${cur}/${recipe.requiredLevel}${ok ? "" : " ⚠"}</span>`;
    };
    let totalTime = 0;
    for (const r of mrp.rows) if (r.recipe) totalTime += (r.recipe.baseTickIntervalSeconds ?? 0) * r.net;
    const rowHtml = (o) => {
      const mid = o.recipe
        ? `<div style="font-variant-numeric:tabular-nums;opacity:.8;">${o.count ? fmtDur((o.recipe.baseTickIntervalSeconds ?? 0) * o.count) : "—"}</div>`
        : `<div style="opacity:.5;">刷取</div>`;
      const fav = o.recipe && modules.fav
        ? `<button data-fav-id="${o.recipe.id}" data-fav-name="${o.name}" data-fav-prof="${o.recipe.profession}" data-fav-count="${o.fav}"
          title="${o.favTitle ?? "按整套缺口加入收藏"}" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:4px;background:rgba(250,204,21,.15);border:1px solid rgba(250,204,21,.4);font-size:11px;">⭐+${o.fav}</button>`
        : "";
      return `<div ${o.toggle ? `data-toggle="${o.toggle}" ` : ""}style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;padding:5px 8px;${o.toggle ? "cursor:pointer;" : ""}border-top:1px solid rgba(255,255,255,.05);">
          <div>${o.arrow}<b>${o.name}</b> ${o.need} ${gate(o.recipe)}</div>
          ${o.short || "<div></div>"}
          ${mid}${fav}
        </div>`;
    };
    const aggRow = (r, o) => rowHtml({ ...o, name: r.name, recipe: r.recipe, count: r.net, fav: r.net,
      need: `<span style="opacity:.6;font-size:11px;">需${r.gross} 有${r.have}</span>`,
      short: `<div style="font-variant-numeric:tabular-nums;color:${r.net ? (r.recipe ? "#fbbf24" : "#f87171") : "#7fe0b8"};">缺 ${r.net}</div>` });
    const nodeHtml = (node, path) => {
      const key = path + "/" + node.name, hasKids = node.children.length > 0, open = calcExpanded.has(key);
      const arrow = hasKids
        ? `<span style="opacity:.6;width:14px;display:inline-block;">${open ? "▾" : "▸"}</span>`
        : `<span style="width:14px;display:inline-block;opacity:.25;">·</span>`;
      const toggle = hasKids ? key : "";
      const html = node.qty == null
        ? aggRow(rowBy.get(node.name), { arrow, toggle })
        : rowHtml({ name: node.name, recipe: node.recipe, count: node.qty, fav: rowBy.get(node.name)?.net ?? 0, arrow, toggle,
          need: `<span style="opacity:.6;font-size:11px;">×${node.qty}</span>` });
      return `<div data-node="${key}">${html}
        ${hasKids && open ? `<div style="margin-left:22px;border-left:1px dashed rgba(138,180,248,.25);">${node.children.map((c) => nodeHtml(c, key)).join("")}</div>` : ""}
      </div>`;
    };
    const tierSatisfied = (t) => t.items.every(([n]) => (rowBy.get(n)?.net ?? 1) === 0);
    if (!calcBlockInit) {
      const first = tiers.find((t) => !tierSatisfied(t));
      if (first) calcBlockOpen.add(first.tier);
      calcBlockInit = true;
    }
    const blockHtml = tiers.map((t) => {
      const sat = tierSatisfied(t);
      const open = calcBlockOpen.has(t.tier);
      return `<div style="margin:10px 0 0;">
        <div data-block="${t.tier}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;
            background:rgba(138,180,248,.07);border-radius:8px;font-weight:600;font-size:13px;">
          <span style="opacity:.7;">${open ? "▾" : "▸"}</span>
          ${t.title}
          <span style="font-size:11px;font-weight:400;color:${sat ? "#7fe0b8" : "#f87171"};">${sat ? "✓ 已满足" : "未满足"}</span>
        </div>
        ${open ? `<div style="background:rgba(255,255,255,.02);border-radius:8px;margin-top:3px;">
          ${t.items.map(([n]) => nodeHtml(mrp.makeTree(n), "T" + t.tier)).join("")}
        </div>` : ""}
      </div>`;
    }).join("");
    const totalTier = calcTotalTier || tiers.find((t) => !tierSatisfied(t))?.tier || last.tier;
    const totalRows = totalTier === last.tier ? mrp.rows
      : computeMrp(tiers.find((t) => t.tier === totalTier).items.map(([name, qty]) => ({ name, qty }))).rows;
    const shortRows = totalRows.filter((r) => r.net > 0);
    const tierBtn = (t) => `<button type="button" data-tier="${t.tier}" title="统计做到 T${t.tier} 还缺多少" style="all:unset;cursor:pointer;padding:1px 7px;border-radius:5px;font-size:11px;
        background:${t.tier === totalTier ? "#1d4ed8" : "rgba(255,255,255,.06)"};color:${t.tier === totalTier ? "#fff" : "#c9d1d9"};">T${t.tier}</button>`;
    const totalHtml = `<div style="margin:14px 0 0;">
      <div data-total style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;
          background:rgba(138,180,248,.07);border-radius:8px;font-weight:600;font-size:13px;">
        <span style="opacity:.7;">${calcTotalOpen ? "▾" : "▸"}</span> 缺口合计
        <span style="display:flex;gap:4px;">${tiers.map(tierBtn).join("")}</span>
        <span style="font-size:11px;font-weight:400;opacity:.7;">${shortRows.length} 种物料</span>
      </div>
      ${calcTotalOpen ? `<div style="background:rgba(255,255,255,.02);border-radius:8px;margin-top:3px;">
        ${shortRows.map((r) => aggRow(r, { arrow: `<span style="width:14px;display:inline-block;opacity:.25;">·</span>`, favTitle: `按 T${totalTier} 的缺口加入收藏` })).join("")}
      </div>` : ""}
    </div>`;
    const classBtn = (c) => {
      const on = c.id === cls.id;
      return `<button type="button" data-class="${c.id}" style="all:unset;cursor:pointer;padding:3px 10px;border-radius:6px;font-size:12px;
        background:${on ? "#1d4ed8" : "rgba(255,255,255,.06)"};color:${on ? "#fff" : "#c9d1d9"};${on ? "font-weight:600;" : ""}">${c.label}</button>`;
    };
    calcPage.innerHTML = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <b style="font-size:14px;">📊 发育计算器 · ${cls.label} · T${last.tier} 套装</b>
        <span style="opacity:.6;font-size:12px;">制造总耗时 ≈ ${fmtDur(totalTime)}</span>
        <span style="flex:1"></span>
        <span id="fh-calc-close" title="关闭" style="cursor:pointer;opacity:.6;">✕</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${CLASS_SETS.map(classBtn).join("")}
        <span style="opacity:.55;font-size:11px;margin-left:6px;">${cls.hint}</span>
      </div>` + blockHtml + totalHtml;
    calcPage.scrollTop = scrollTop;
    calcPage.querySelector("#fh-calc-close").onclick = hideCalcPage;
    calcPage.onclick = (ev) => {
      if (ev.target.closest?.("[data-total]")) { calcTotalOpen = !calcTotalOpen; return renderCalcPage(); }
      const blk = ev.target.closest?.("[data-block]");
      if (blk && !ev.target.closest("[data-node]")) {
        const t = +blk.dataset.block;
        if (calcBlockOpen.has(t)) calcBlockOpen.delete(t); else calcBlockOpen.add(t);
        return renderCalcPage();
      }
      const t = ev.target.closest?.("[data-toggle]");
      if (!t || !t.dataset.toggle || t.tagName === "BUTTON") return;
      const key = t.dataset.toggle;
      if (calcExpanded.has(key)) calcExpanded.delete(key); else calcExpanded.add(key);
      renderCalcPage();
    };
    for (const b of calcPage.querySelectorAll("button[data-tier]"))
      b.onclick = (ev) => { ev.stopPropagation(); const t = +b.dataset.tier; if (t !== calcTotalTier || !calcTotalOpen) selectCalcTotalTier(t); };
    for (const b of calcPage.querySelectorAll("button[data-class]"))
      b.onclick = (ev) => { ev.stopPropagation(); if (b.dataset.class !== calcClassId) selectCalcClass(b.dataset.class); };
    for (const b of calcPage.querySelectorAll("button[data-fav-id]")) {
      b.onclick = (ev) => {
        ev.stopPropagation();
        const favs = loadFavs().filter((f) => f.id !== +b.dataset.favId);
        favs.unshift({ id: +b.dataset.favId, name: b.dataset.favName, prof: b.dataset.favProf, count: +b.dataset.favCount || 0, ts: Date.now() });
        saveFavs(favs.slice(0, 12));
        b.textContent = "✅"; b.onclick = null;
      };
    }
  }
  function toggleCalcPage() {
    if (calcPage) return hideCalcPage();
    hideFavPage();
    calcPage = createOverlayPanel("fh-calc-page");
    syncPanelPos(calcPage);
    renderCalcPage();
    calcNav?.classList.add("active");
  }
  function installCalcNav() {
    if (!modules.calc) return;
    const btn = installSidebarNav("fh-calc-nav", "📊", "发育", "发育计算器（FishIdle HUD）",
      toggleCalcPage, document.getElementById("fh-fav-nav") ?? document.querySelector(".skill-entry--market"));
    if (btn) calcNav = btn;
  }

  const MODULES_LS = "fishidle-hud.modules";
  const MODULES = [
    { key: "hud", label: "悬浮面板", desc: "右上角的悬浮面板和置顶小窗" },
    { key: "calc", label: "发育计算器", desc: "左侧栏的发育入口" },
    { key: "fav", label: "收藏夹", desc: "左侧栏的收藏入口，以及对话框和计算器里的收藏按钮" },
    { key: "dialog", label: "对话框增强", desc: "开始制造 / 采集 / 炼金对话框里的升级次数和预计时间" },
    { key: "lodge", label: "渔舍计算器", desc: "渔舍页显示每个材料的差额（需求 − 已填入 − 背包）" },
  ];
  const modules = Object.fromEntries(MODULES.map((m) => [m.key, true]));
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(MODULES_LS) || "{}")))
      if (k in modules && typeof v === "boolean") modules[k] = v;
  } catch {}
  function applyModules() {
    root.style.display = modules.hud ? "" : "none";
    if (!modules.hud && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (modules.calc) installCalcNav(); else { hideCalcPage(); calcNav?.remove(); calcNav = null; }
    if (modules.fav) installFavNav(); else { hideFavPage(); favPageNav?.remove(); favPageNav = null; }
    document.getElementById(FH_INFO_ID)?.remove();
    enhanceStartDialog();
    if (calcPage) renderCalcPage();
  }
  function setModule(key, on) {
    modules[key] = on;
    try { localStorage.setItem(MODULES_LS, JSON.stringify(modules)); } catch {}
    applyModules();
  }
  const SETTINGS_TAB_ID = "fh-settings-tab", SETTINGS_PANE_ID = "fh-settings-pane";
  let settingsTabOn = false, settingsTabBack = null;
  function setSettingsTab(on) {
    if (on && !settingsTabOn) {
      settingsTabBack = [...document.querySelectorAll(".settings-panel .sidebar-tab.active")].find((t) => t.id !== SETTINGS_TAB_ID) ?? null;
      settingsTabBack?.classList.remove("active");
    }
    if (!on && settingsTabBack) { settingsTabBack.classList.add("active"); settingsTabBack = null; }
    settingsTabOn = on;
    document.getElementById(SETTINGS_TAB_ID)?.classList.toggle("active", on);
    const pane = document.getElementById(SETTINGS_PANE_ID);
    if (pane) pane.style.display = on ? "" : "none";
    const content = document.querySelector(".settings-panel .settings-content");
    if (content) for (const el of content.children) if (el.id !== SETTINGS_PANE_ID) el.style.display = on ? "none" : "";
  }
  function installSettingsTab() {
    const sidebar = document.querySelector(".settings-panel .settings-sidebar");
    const content = document.querySelector(".settings-panel .settings-content");
    const native = sidebar ? [...sidebar.querySelectorAll(".sidebar-tab")] : [];
    if (!content || !native.length || document.getElementById(SETTINGS_TAB_ID)) return;
    setSettingsTab(false);
    const tab = native[0].cloneNode(true);
    tab.id = SETTINGS_TAB_ID;
    tab.classList.remove("active");
    tab.querySelector(".tab-label").textContent = "jojo-plugin";
    const use = tab.querySelector("use");
    if (use && document.getElementById("icon-magic")) use.setAttribute("xlink:href", "#icon-magic");
    tab.addEventListener("click", () => setSettingsTab(true));
    native.at(-1).after(tab);
    const pane = document.createElement("div"), host = content.firstElementChild;
    const scopes = (host?.getAttributeNames() ?? []).filter((n) => n.startsWith("data-v-"));
    pane.id = SETTINGS_PANE_ID;
    pane.className = host?.className ?? "";
    for (const n of scopes) pane.setAttribute(n, "");
    pane.style.display = "none";
    const sc = scopes.map((n) => `${n}=""`).join(" ");
    pane.innerHTML = `<section class="section" ${sc}>
        <div class="section-title" ${sc}>jojo-plugin</div>
        <p class="hint" ${sc}>按模块开关，改动立即生效，并保存在本浏览器里。</p>
        ${MODULES.map((m) => `<label class="settings-option">
          <input class="settings-check" type="checkbox" data-fh-module="${m.key}"${modules[m.key] ? " checked" : ""}>
          <span ${sc}><strong ${sc}>${m.label}</strong><span class="hint" style="display:block;margin-top:2px;" ${sc}>${m.desc}</span></span>
        </label>`).join("")}
        <label class="field-row" ${sc}>
          <span class="field-label" ${sc}>药水告警阈值（分钟）</span>
          <input class="input" type="number" min="0" max="1440" step="1" data-fh-potion-low value="${potionLowMin}" ${sc}>
        </label>
        <p class="hint" ${sc}>战斗中药水的耗尽时间低于它时在面板里标黄，0 表示不提醒。</p>
      </section>`;
    pane.addEventListener("change", (e) => {
      const k = e.target.dataset.fhModule;
      if (k in modules) { setModule(k, e.target.checked); return; }
      if (e.target.dataset.fhPotionLow == null) return;
      potionLowMin = Number.isNaN(e.target.valueAsNumber) ? potionLowMin : potionLowOf(e.target.valueAsNumber);
      e.target.value = potionLowMin;
      try { localStorage.setItem(POTION_LOW_LS, String(potionLowMin)); } catch {}
    });
    content.appendChild(pane);
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest?.(".settings-panel .sidebar-tab");
    if (t && t.id !== SETTINGS_TAB_ID && settingsTabOn) setSettingsTab(false);
  }, true);
  try {
    const pos = JSON.parse(localStorage.getItem("fishidle-hud.pos") || "null");
    if (pos) { root.style.left = pos.left; root.style.top = pos.top; root.style.right = "auto"; }
  } catch {}
  root.querySelector("#fh-head").addEventListener("mousedown", (e) => {
    if (e.target.id === "fh-min" || e.target.id === "fh-pip" || e.target.id === "fh-ka") return;
    const sx = e.clientX - root.offsetLeft, sy = e.clientY - root.offsetTop;
    const mv = (ev) => {
      root.style.left = Math.max(0, Math.min(ev.clientX - sx, innerWidth - 60)) + "px";
      root.style.top = Math.max(0, Math.min(ev.clientY - sy, innerHeight - 28)) + "px";
      root.style.right = "auto";
    };
    const up = () => {
      removeEventListener("mousemove", mv); removeEventListener("mouseup", up);
      try { localStorage.setItem("fishidle-hud.pos", JSON.stringify({ left: root.style.left, top: root.style.top })); } catch {}
    };
    addEventListener("mousemove", mv); addEventListener("mouseup", up);
  });
  let collapsed = (() => { try { return localStorage.getItem("fishidle-hud.collapsed") === "1"; } catch { return false; } })();
  const applyCollapsed = () => {
    elBody.style.display = collapsed ? "none" : "";
    root.querySelector("#fh-min").textContent = collapsed ? "＋" : "—";
  };
  root.querySelector("#fh-min").addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem("fishidle-hud.collapsed", collapsed ? "1" : "0"); } catch {}
    applyCollapsed();
  });
  applyCollapsed();

  let probeQueued = false, probeLastAt = 0;
  function probe() {
    probeLastAt = Date.now();
    if (!getGameStore()) return;
    const now = Date.now();
    const m = buildModel();
    if (!document.hidden && modules.hud) renderDom(m);
    renderPip(m);
    runAlertEffects(m, now);
  }
  function queueProbe() {
    const now = Date.now();
    if (probeQueued || now - probeLastAt < 250) return;
    probeQueued = true;
    setTimeout(() => { probeQueued = false; probe(); }, 0);
  }
  function hookProbe(g) {
    if (typeof g?.$subscribe !== "function") return;
    try { g.$subscribe(() => queueProbe(), { detached: true }); } catch {}
  }

  function tick() {
    const m = buildModel();
    if (!document.hidden && modules.hud) renderDom(m);
    renderPip(m);
    if (keepAlive.on && document.hidden) { try { getPiniaStore("combatVfx")?.prune?.(); } catch {} }
    if (modules.lodge) renderLodgeGaps();
  }
  function startUi() {
    applyModules();
    document.body.appendChild(root);
    hudObserver.observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 500);
    setInterval(probe, 2000);
    tick();
    probe();
  }
  if (document.body) startUi();
  else document.addEventListener("DOMContentLoaded", startUi, { once: true });
  console.log(`[FishIdle HUD] v${VERSION} 已启动`);
})();
