// Plans and limits. The open-source default is "everything is free and unlimited".
// A private overlay (see lib/private.js) can replace these to add billing: it decides
// whether a user may run an AI action and what the UI shows about their plan.

export let plans = {
  name: "open",
  // kind: convert | edit | analyze | tailor | fit. Returns { ok } or { ok: false, message }.
  canUse: async (_user, _kind) => ({ ok: true }),
  // What the UI shows, or null for nothing. Shape when present:
  // { plan, label, remaining, limit, resetsAt, expiresAt, upgradeUrl, portalUrl }
  status: async (_user) => null,
  // Shown on the landing page when billing is installed: { freeActions, pass: { price, days }, pro: { price } }
  pricing: null,
};

export function setPlans(overrides) {
  plans = { ...plans, ...overrides };
}

// Express middleware: 402 with an upgrade hint when the plan doesn't allow the action.
export const gate = (kind) => async (req, res, next) => {
  try {
    const g = await plans.canUse(req.user, kind);
    if (g.ok) return next();
    res.status(402).json({ error: g.message || "This action isn't available on your plan.", upgrade: true, plan: await plans.status(req.user) });
  } catch (err) {
    next(err);
  }
};
