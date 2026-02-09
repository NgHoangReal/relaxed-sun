import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Where Winds Meet – Gear Buff Calculator + Inventory Optimizer
 * Single-file React app (works in Vite / CRA / Next client component).
 * - 8 gear slots
 * - Create unlimited items with 5–6 buff lines
 * - Equip 8 items and aggregate buffs (same buff names sum)
 * - Define Necessary Buff Targets and compare current totals vs targets
 * - Optimizer: picks 8 items (one per slot) that best meet targets and then maximizes recommended lines
 * - Persists to localStorage
 */

// -----------------------------
// Types
// -----------------------------

type SlotKey =
  | "Weapon 1"
  | "Weapon 2"
  | "Support 1"
  | "Support 2"
  | "Helmet"
  | "Vest"
  | "Arms"
  | "Legs";

const SLOTS: SlotKey[] = [
  "Weapon 1",
  "Weapon 2",
  "Support 1",
  "Support 2",
  "Helmet",
  "Vest",
  "Arms",
  "Legs",
];

type BuffLine = {
  id: string;
  name: string; // e.g., "Momentum"
  value: number; // e.g., 15
  recommended: boolean; // if the game flags this as a recommended line
};

type Item = {
  id: string;
  name: string;
  slot: SlotKey;
  buffs: BuffLine[];
};

type Targets = Record<string, number>; // buffName -> required value

type Equipped = Record<SlotKey, string | null>; // slot -> itemId

// -----------------------------
// Utilities
// -----------------------------

function uid(prefix = "id") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function clampInt(n: number, min = 0, max = 1e9) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeBuffName(name: string) {
  return name.trim();
}

function sumBuffs(
  items: Item[]
): Record<string, { total: number; recommendedLines: number; lines: number }> {
  const map: Record<
    string,
    { total: number; recommendedLines: number; lines: number }
  > = {};
  for (const it of items) {
    for (const b of it.buffs) {
      const key = normalizeBuffName(b.name);
      if (!key) continue;
      if (!map[key]) map[key] = { total: 0, recommendedLines: 0, lines: 0 };
      map[key].total += Number(b.value) || 0;
      map[key].lines += 1;
      if (b.recommended) map[key].recommendedLines += 1;
    }
  }
  return map;
}

function computeDeficits(totals: Record<string, number>, targets: Targets) {
  const rows = Object.entries(targets)
    .filter(([k]) => normalizeBuffName(k))
    .map(([name, required]) => {
      const key = normalizeBuffName(name);
      const req = Number(required) || 0;
      const cur = Number(totals[key] ?? 0) || 0;
      const diff = cur - req;
      return {
        name: key,
        current: cur,
        required: req,
        diff,
        missing: Math.max(0, -diff),
      };
    })
    .sort((a, b) => b.missing - a.missing || a.name.localeCompare(b.name));
  const totalMissing = rows.reduce((acc, r) => acc + r.missing, 0);
  return { rows, totalMissing };
}

function parseTargetsFromText(text: string): Targets {
  // Supports:
  // Momentum: 100
  // Momentum 100
  // Crit Rate = 25
  // One per line.
  const targets: Targets = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)(?:\s*[:=]\s*|\s+)(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) continue;
    const name = normalizeBuffName(m[1]);
    const val = Number(m[2]);
    if (!name || !Number.isFinite(val)) continue;
    targets[name] = val;
  }
  return targets;
}

function targetsToText(targets: Targets) {
  return Object.entries(targets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

// -----------------------------
// Optimizer
// -----------------------------

/**
 * Heuristic score:
 * - Large penalty for any remaining deficit vs targets
 * - Then reward recommended lines
 * - Then reward total contribution to targeted buffs
 */
function scoreBuild(items: Item[], targets: Targets) {
  const totals: Record<string, number> = {};
  let recommendedLines = 0;
  let totalLines = 0;
  for (const it of items) {
    for (const b of it.buffs) {
      const key = normalizeBuffName(b.name);
      if (!key) continue;
      totals[key] = (totals[key] ?? 0) + (Number(b.value) || 0);
      totalLines += 1;
      if (b.recommended) recommendedLines += 1;
    }
  }

  // Deficit penalty: quadratic-ish to heavily prefer meeting requirements.
  let deficitPenalty = 0;
  let totalMissing = 0;
  for (const [name, reqRaw] of Object.entries(targets)) {
    const key = normalizeBuffName(name);
    const req = Number(reqRaw) || 0;
    if (!key || req <= 0) continue;
    const cur = Number(totals[key] ?? 0) || 0;
    const missing = Math.max(0, req - cur);
    totalMissing += missing;
    deficitPenalty += missing * missing;
  }

  // Targeted contribution: sum of amounts on targeted buffs only.
  let targetedContribution = 0;
  const targetKeys = new Set(Object.keys(targets).map(normalizeBuffName));
  for (const [k, v] of Object.entries(totals)) {
    if (targetKeys.has(k)) targetedContribution += v;
  }

  // Final score: higher is better.
  // If deficits exist, the penalty dominates, forcing builds that meet targets when possible.
  const score =
    -deficitPenalty * 1000 + // dominate
    recommendedLines * 50 +
    targetedContribution * 2 +
    totalLines * 0.1;

  return { score, deficitPenalty, totalMissing, recommendedLines, totals };
}

function perItemHeuristic(item: Item, targets: Targets) {
  const targetKeys = new Set(Object.keys(targets).map(normalizeBuffName));
  let targeted = 0;
  let rec = 0;
  for (const b of item.buffs) {
    const key = normalizeBuffName(b.name);
    if (!key) continue;
    if (targetKeys.has(key)) targeted += Number(b.value) || 0;
    if (b.recommended) rec += 1;
  }
  return rec * 10 + targeted; // quick filter only
}

/**
 * Beam-search optimizer.
 * - For each slot, pre-sort candidate items by heuristic and keep top K
 * - Expand slot-by-slot, keeping top BEAM partial builds
 */
function optimize(
  items: Item[],
  targets: Targets,
  opts?: { topKPerSlot?: number; beamWidth?: number }
) {
  const topKPerSlot = opts?.topKPerSlot ?? 50;
  const beamWidth = opts?.beamWidth ?? 2500;

  const bySlot: Record<SlotKey, Item[]> = Object.fromEntries(
    SLOTS.map((s) => [s, []])
  ) as any;
  for (const it of items) bySlot[it.slot].push(it);

  // If some slots have no items, optimization cannot fill all.
  const missingSlots = SLOTS.filter((s) => bySlot[s].length === 0);

  // Pre-prune and sort candidates.
  for (const s of SLOTS) {
    bySlot[s] = bySlot[s]
      .slice()
      .sort(
        (a, b) => perItemHeuristic(b, targets) - perItemHeuristic(a, targets)
      )
      .slice(0, topKPerSlot);
  }

  type Partial = {
    chosen: Item[];
    slotsFilled: number;
    approxScore: number;
  };

  let beam: Partial[] = [{ chosen: [], slotsFilled: 0, approxScore: 0 }];

  for (const slot of SLOTS) {
    const candidates = bySlot[slot];
    if (candidates.length === 0) continue;

    const next: Partial[] = [];
    for (const p of beam) {
      for (const cand of candidates) {
        const chosen = [...p.chosen, cand];
        // Approx score using full score on partial (good enough for beam)
        const s = scoreBuild(chosen, targets);
        next.push({
          chosen,
          slotsFilled: p.slotsFilled + 1,
          approxScore: s.score,
        });
      }
    }

    next.sort((a, b) => b.approxScore - a.approxScore);
    beam = next.slice(0, beamWidth);
  }

  // Best among beam.
  const best = beam[0]?.chosen ?? [];
  const bestScore = scoreBuild(best, targets);

  return {
    best,
    bestScore,
    missingSlots,
    searched: { topKPerSlot, beamWidth, beamSizeFinal: beam.length },
  };
}

// -----------------------------
// Local Storage
// -----------------------------

const LS_KEY = "wwm_build_planner_v1";

type Persisted = {
  items: Item[];
  equipped: Equipped;
  targets: Targets;
};

function loadState(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Persisted;
  } catch {
    return null;
  }
}

function saveState(st: Persisted) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(st));
  } catch {
    // ignore
  }
}

// -----------------------------
// UI Components
// -----------------------------

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
      {children}
    </span>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function TextButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50 active:bg-gray-100"
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl bg-black px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border px-3 py-2 text-sm"
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(Number(e.target.value))}
      placeholder={placeholder}
      className="w-full rounded-xl border px-3 py-2 text-sm"
    />
  );
}

// -----------------------------
// Main App
// -----------------------------

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [equipped, setEquipped] = useState<Equipped>(
    () => Object.fromEntries(SLOTS.map((s) => [s, null])) as Equipped
  );
  const [targets, setTargets] = useState<Targets>({});

  // Inventory UI state
  const [slotFilter, setSlotFilter] = useState<SlotKey | "All">("All");
  const [search, setSearch] = useState<string>("");

  // Item editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = useMemo(
    () => items.find((x) => x.id === editingId) ?? null,
    [items, editingId]
  );

  const [draftName, setDraftName] = useState<string>("");
  const [draftSlot, setDraftSlot] = useState<SlotKey>("Weapon 1");
  const [draftBuffs, setDraftBuffs] = useState<BuffLine[]>([]);

  const [targetsText, setTargetsText] = useState<string>("");

  const [optResult, setOptResult] = useState<null | {
    best: Item[];
    bestScore: ReturnType<typeof scoreBuild>;
    missingSlots: SlotKey[];
    searched: any;
  }>(null);

  // Load persisted
  useEffect(() => {
    const st = loadState();
    if (!st) return;
    if (Array.isArray(st.items)) setItems(st.items);
    if (st.equipped) setEquipped(st.equipped as Equipped);
    if (st.targets) {
      setTargets(st.targets);
      setTargetsText(targetsToText(st.targets));
    }
  }, []);

  // Persist
  useEffect(() => {
    saveState({ items, equipped, targets });
  }, [items, equipped, targets]);

  // Derived
  const equippedItems = useMemo(() => {
    const map = new Map(items.map((i) => [i.id, i] as const));
    const arr: Item[] = [];
    for (const s of SLOTS) {
      const id = equipped[s];
      if (!id) continue;
      const it = map.get(id);
      if (it) arr.push(it);
    }
    return arr;
  }, [items, equipped]);

  const totals = useMemo(() => {
    const summed = sumBuffs(equippedItems);
    const flat: Record<string, number> = {};
    for (const [k, v] of Object.entries(summed)) flat[k] = v.total;
    return flat;
  }, [equippedItems]);

  const deficits = useMemo(
    () => computeDeficits(totals, targets),
    [totals, targets]
  );

  const inventoryView = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((it) => (slotFilter === "All" ? true : it.slot === slotFilter))
      .filter((it) => {
        if (!q) return true;
        const hay = `${it.name} ${it.slot} ${it.buffs
          .map((b) => `${b.name} ${b.value}`)
          .join(" ")}`.toLowerCase();
        return hay.includes(q);
      })
      .sort(
        (a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name)
      );
  }, [items, slotFilter, search]);

  // Editor helpers
  function startCreate() {
    setEditingId(null);
    setDraftName("");
    setDraftSlot("Weapon 1");
    setDraftBuffs([{ id: uid("b"), name: "", value: 0, recommended: false }]);
  }

  function startEdit(itemId: string) {
    const it = items.find((x) => x.id === itemId);
    if (!it) return;
    setEditingId(it.id);
    setDraftName(it.name);
    setDraftSlot(it.slot);
    setDraftBuffs(it.buffs.map((b) => ({ ...b })));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftName("");
    setDraftBuffs([]);
  }

  function saveItem() {
    const name = draftName.trim() || "Unnamed Item";
    const slot = draftSlot;
    const buffs = draftBuffs
      .map((b) => ({
        ...b,
        name: normalizeBuffName(b.name),
        value: Number(b.value) || 0,
      }))
      .filter((b) => b.name);

    // soft rule: 5–6 lines, but allow any and highlight instead of blocking

    if (editingId) {
      setItems((prev) =>
        prev.map((x) => (x.id === editingId ? { ...x, name, slot, buffs } : x))
      );
    } else {
      const it: Item = { id: uid("it"), name, slot, buffs };
      setItems((prev) => [it, ...prev]);
    }
    cancelEdit();
  }

  function deleteItem(itemId: string) {
    setItems((prev) => prev.filter((x) => x.id !== itemId));
    setEquipped((prev) => {
      const next = { ...prev };
      for (const s of SLOTS) if (next[s] === itemId) next[s] = null;
      return next;
    });
    if (editingId === itemId) cancelEdit();
  }

  function addBuffLine() {
    setDraftBuffs((prev) => [
      ...prev,
      { id: uid("b"), name: "", value: 0, recommended: false },
    ]);
  }

  function removeBuffLine(buffId: string) {
    setDraftBuffs((prev) => prev.filter((b) => b.id !== buffId));
  }

  function updateBuffLine(buffId: string, patch: Partial<BuffLine>) {
    setDraftBuffs((prev) =>
      prev.map((b) => (b.id === buffId ? { ...b, ...patch } : b))
    );
  }

  function setEquippedForSlot(slot: SlotKey, itemId: string | null) {
    setEquipped((prev) => ({ ...prev, [slot]: itemId }));
  }

  function applyTargetsText() {
    const parsed = parseTargetsFromText(targetsText);
    setTargets(parsed);
  }

  function clearAll() {
    setItems([]);
    setEquipped(Object.fromEntries(SLOTS.map((s) => [s, null])) as Equipped);
    setTargets({});
    setTargetsText("");
    setOptResult(null);
  }

  function runOptimizer() {
    const res = optimize(items, targets, { topKPerSlot: 60, beamWidth: 3000 });
    setOptResult(res);
    // Auto-equip best (if it fills all slots present)
    const nextEq: Equipped = { ...equipped };
    for (const slot of SLOTS) nextEq[slot] = null;
    for (const it of res.best) nextEq[it.slot] = it.id;
    setEquipped(nextEq);
  }

  // Quick stats
  const equippedScore = useMemo(
    () => scoreBuild(equippedItems, targets),
    [equippedItems, targets]
  );

  const warnings = useMemo(() => {
    const w: string[] = [];
    if (Object.keys(targets).length === 0)
      w.push(
        "No necessary buffs set. Add targets to enable meaningful comparisons and optimization."
      );
    return w;
  }, [targets]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6 flex flex-col gap-2">
          <h1 className="text-2xl font-bold">
            Where Winds Meet – Build Planner
          </h1>
          <p className="text-sm text-gray-600">
            Track inventory, equip 8 slots, aggregate buffs, compare against
            required targets, and auto-select a best set.
          </p>
          {warnings.length > 0 && (
            <div className="rounded-2xl border bg-white p-3 text-sm text-gray-700">
              {warnings.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </div>
          )}
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left column */}
          <div className="flex flex-col gap-4 lg:col-span-2">
            <Section
              title="Inventory"
              right={
                <div className="flex items-center gap-2">
                  <TextButton onClick={startCreate}>+ New Item</TextButton>
                  <TextButton onClick={clearAll}>Reset</TextButton>
                </div>
              }
            >
              <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">
                    Slot filter
                  </label>
                  <select
                    value={slotFilter}
                    onChange={(e) => setSlotFilter(e.target.value as any)}
                    className="w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    <option value="All">All</option>
                    {SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-gray-600">
                    Search
                  </label>
                  <Input
                    value={search}
                    onChange={setSearch}
                    placeholder="Search item name, buff name, value…"
                  />
                </div>
              </div>

              <div className="space-y-3">
                {inventoryView.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-4 text-sm text-gray-600">
                    No items yet. Click <b>New Item</b> to add gear.
                  </div>
                ) : (
                  inventoryView.map((it) => {
                    const recCount = it.buffs.filter(
                      (b) => b.recommended
                    ).length;
                    return (
                      <div
                        key={it.id}
                        className="rounded-2xl border bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-semibold">
                                {it.name}
                              </div>
                              <Pill>{it.slot}</Pill>
                              <Pill>
                                {it.buffs.length} lines
                                {recCount ? ` • ${recCount} recommended` : ""}
                              </Pill>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {it.buffs.length === 0 ? (
                                <span className="text-xs text-gray-500">
                                  No buffs
                                </span>
                              ) : (
                                it.buffs.map((b) => (
                                  <span
                                    key={b.id}
                                    className={
                                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs " +
                                      (b.recommended ? "bg-gray-100" : "")
                                    }
                                  >
                                    <span className="font-medium">
                                      {b.name}
                                    </span>
                                    <span className="text-gray-600">
                                      +{b.value}
                                    </span>
                                    {b.recommended && (
                                      <span className="text-gray-700">★</span>
                                    )}
                                  </span>
                                ))
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <TextButton onClick={() => startEdit(it.id)}>
                              Edit
                            </TextButton>
                            <TextButton onClick={() => deleteItem(it.id)}>
                              Delete
                            </TextButton>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Section>

            <Section
              title="Equip & Totals"
              right={
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    onClick={runOptimizer}
                    disabled={items.length === 0}
                  >
                    Optimize & Equip Best
                  </PrimaryButton>
                </div>
              }
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {SLOTS.map((slot) => {
                  const candidates = items
                    .filter((i) => i.slot === slot)
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <div key={slot} className="rounded-2xl border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-sm font-semibold">{slot}</div>
                        <TextButton
                          onClick={() => setEquippedForSlot(slot, null)}
                        >
                          Clear
                        </TextButton>
                      </div>
                      <select
                        value={equipped[slot] ?? ""}
                        onChange={(e) =>
                          setEquippedForSlot(slot, e.target.value || null)
                        }
                        className="w-full rounded-xl border px-3 py-2 text-sm"
                      >
                        <option value="">(not equipped)</option>
                        {candidates.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </select>
                      <div className="mt-2 text-xs text-gray-600">
                        {candidates.length} item(s) for this slot
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border p-3">
                  <div className="mb-2 text-sm font-semibold">
                    Aggregated buffs (equipped)
                  </div>
                  {Object.keys(totals).length === 0 ? (
                    <div className="text-sm text-gray-600">
                      Equip items to see totals.
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-xl border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                          <tr className="border-b">
                            <th className="px-3 py-2 text-left font-medium">
                              Buff
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(totals)
                            .sort(
                              (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
                            )
                            .map(([k, v]) => (
                              <tr key={k} className="border-b last:border-b-0">
                                <td className="px-3 py-2">{k}</td>
                                <td className="px-3 py-2 text-right">{v}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-semibold">
                      Necessary buffs comparison
                    </div>
                    <Pill>
                      Missing total:{" "}
                      <b className="ml-1">{deficits.totalMissing}</b>
                    </Pill>
                  </div>
                  {Object.keys(targets).length === 0 ? (
                    <div className="text-sm text-gray-600">
                      Add targets below to compare.
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-xl border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                          <tr className="border-b">
                            <th className="px-3 py-2 text-left font-medium">
                              Buff
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Current
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Required
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Δ
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {deficits.rows.map((r) => (
                            <tr
                              key={r.name}
                              className="border-b last:border-b-0"
                            >
                              <td className="px-3 py-2">{r.name}</td>
                              <td className="px-3 py-2 text-right">
                                {r.current}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {r.required}
                              </td>
                              <td
                                className={
                                  "px-3 py-2 text-right " +
                                  (r.diff >= 0
                                    ? "text-gray-800"
                                    : "text-red-600")
                                }
                              >
                                {r.diff >= 0 ? `+${r.diff}` : r.diff}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-3 rounded-xl border bg-white p-3 text-xs text-gray-700">
                    <div className="font-medium">Equipped build quality</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Pill>
                        Recommended lines: {equippedScore.recommendedLines}
                      </Pill>
                      <Pill>Missing total: {equippedScore.totalMissing}</Pill>
                      <Pill>
                        Deficit penalty: {equippedScore.deficitPenalty}
                      </Pill>
                    </div>
                    <div className="mt-2 text-gray-600">
                      Tip: If “Missing total” isn’t 0, you’re below the
                      target(s). The optimizer prioritizes eliminating deficits
                      first.
                    </div>
                  </div>
                </div>
              </div>
            </Section>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            <Section
              title={editingId ? "Edit Item" : "Create Item"}
              right={
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    onClick={saveItem}
                    disabled={draftBuffs.length === 0}
                  >
                    Save
                  </PrimaryButton>
                  <TextButton onClick={cancelEdit}>Cancel</TextButton>
                </div>
              }
            >
              {editingId === null && draftBuffs.length === 0 ? (
                <div className="text-sm text-gray-600">
                  Click <b>New Item</b> to start.
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Item name
                    </label>
                    <Input
                      value={draftName}
                      onChange={setDraftName}
                      placeholder="e.g., Azure Blade"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Slot
                    </label>
                    <select
                      value={draftSlot}
                      onChange={(e) => setDraftSlot(e.target.value as SlotKey)}
                      className="w-full rounded-xl border px-3 py-2 text-sm"
                    >
                      {SLOTS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="rounded-2xl border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-semibold">Buff lines</div>
                      <TextButton onClick={addBuffLine}>+ Add line</TextButton>
                    </div>

                    <div className="space-y-2">
                      {draftBuffs.map((b) => (
                        <div key={b.id} className="grid grid-cols-12 gap-2">
                          <div className="col-span-6">
                            <Input
                              value={b.name}
                              onChange={(v) =>
                                updateBuffLine(b.id, { name: v })
                              }
                              placeholder="Buff name (e.g., Momentum)"
                            />
                          </div>
                          <div className="col-span-3">
                            <NumberInput
                              value={b.value}
                              onChange={(v) =>
                                updateBuffLine(b.id, { value: v })
                              }
                              placeholder="Value"
                            />
                          </div>
                          <div className="col-span-2 flex items-center justify-center">
                            <label className="flex items-center gap-2 text-xs text-gray-700">
                              <input
                                type="checkbox"
                                checked={b.recommended}
                                onChange={(e) =>
                                  updateBuffLine(b.id, {
                                    recommended: e.target.checked,
                                  })
                                }
                              />
                              ★
                            </label>
                          </div>
                          <div className="col-span-1 flex items-center justify-end">
                            <button
                              type="button"
                              onClick={() => removeBuffLine(b.id)}
                              className="rounded-lg border px-2 py-2 text-xs hover:bg-gray-50"
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-2 text-xs text-gray-600">
                      Note: Items usually have 5–6 lines, but this tool allows
                      any number.
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <Section
              title="Necessary Buff Targets"
              right={
                <div className="flex items-center gap-2">
                  <PrimaryButton onClick={applyTargetsText}>
                    Apply
                  </PrimaryButton>
                  <TextButton
                    onClick={() => {
                      setTargets({});
                      setTargetsText("");
                    }}
                  >
                    Clear
                  </TextButton>
                </div>
              }
            >
              <div className="text-sm text-gray-700">
                Enter one target per line. Formats supported: <b>Buff: 100</b>{" "}
                or <b>Buff 100</b>.
              </div>
              <textarea
                value={targetsText}
                onChange={(e) => setTargetsText(e.target.value)}
                rows={8}
                className="mt-2 w-full rounded-2xl border p-3 text-sm"
                placeholder={"Momentum: 100\nCrit Rate: 25\nDefense: 300"}
              />
              <div className="mt-2 text-xs text-gray-600">
                Your build totals will be compared against these targets
                (deficits highlighted in red). The optimizer prioritizes meeting
                targets, then maximizing ★ recommended lines.
              </div>
            </Section>

            <Section title="Optimizer Result">
              {!optResult ? (
                <div className="text-sm text-gray-600">
                  Click <b>Optimize & Equip Best</b> to auto-select one item per
                  slot.
                </div>
              ) : (
                <div className="space-y-3">
                  {optResult.missingSlots.length > 0 && (
                    <div className="rounded-2xl border bg-white p-3 text-sm text-gray-700">
                      Missing items for slots:{" "}
                      <b>{optResult.missingSlots.join(", ")}</b>. Add at least
                      one item per slot to fully optimize.
                    </div>
                  )}

                  <div className="rounded-2xl border p-3">
                    <div className="text-sm font-semibold">
                      Best build summary
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Pill>
                        Recommended lines:{" "}
                        {optResult.bestScore.recommendedLines}
                      </Pill>
                      <Pill>
                        Missing total: {optResult.bestScore.totalMissing}
                      </Pill>
                      <Pill>
                        Deficit penalty: {optResult.bestScore.deficitPenalty}
                      </Pill>
                    </div>
                    <div className="mt-2 text-xs text-gray-600">
                      Search settings: topK/slot=
                      {optResult.searched.topKPerSlot}, beamWidth=
                      {optResult.searched.beamWidth}
                    </div>
                  </div>

                  <div className="rounded-2xl border p-3">
                    <div className="mb-2 text-sm font-semibold">
                      Chosen items
                    </div>
                    <div className="space-y-2">
                      {SLOTS.map((slot) => {
                        const it = optResult.best.find((x) => x.slot === slot);
                        return (
                          <div
                            key={slot}
                            className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm"
                          >
                            <div className="text-gray-600">{slot}</div>
                            <div className="font-medium">
                              {it ? it.name : "(none)"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <div className="rounded-2xl border bg-white p-4 text-xs text-gray-600">
              <div className="font-medium text-gray-700">Notes</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  Buff names must match exactly to be summed (case-sensitive
                  except whitespace). Keep your naming consistent.
                </li>
                <li>
                  ★ Recommended lines matter as a tiebreaker after meeting
                  necessary buff targets.
                </li>
                <li>
                  If you want different priorities (e.g., raw power), adjust{" "}
                  <code>scoreBuild()</code> in the code.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <footer className="mt-8 text-xs text-gray-500">
          Data is stored locally in your browser (localStorage). Export/share
          can be added next.
        </footer>
      </div>
    </div>
  );
}
