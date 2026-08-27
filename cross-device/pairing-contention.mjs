// Invite-contention diagnostics for the matrix's contention row.
//
// The gap this closes: `meshRow` mints a FRESH invite per joiner, so no row in
// this harness had ever put two candidates on ONE invite. The 2026-08-26 field
// failure (three phones on 4G, nobody joined) lived in exactly that gap, and
// reproducing it surfaced a second bug — every host-side refusal called
// `candidate.close()`, which does not exist on blind-pairing-core's
// MemberRequest. The TypeError landed in `catch (_) {}`, no reply was ever
// written to the DHT mailbox, and the guest waited out its full 120 s deadline.
//
// So "a loser loses" is not the assertion worth making — a hang satisfies it.
// The assertion is that a loser learns it lost FAST and for a NAMED reason.
//
// The vocabulary is imported and checked for MEMBERSHIP, not just borrowed:
// `JOIN_REASON` is what the backend actually puts on the wire, and a loser whose
// reason is outside that set — a renamed slug, or a host-side policy word like
// 'exhausted' leaking through — breaks this row instead of quietly passing it.
import { JOIN_REASON } from '../../listam-packages/packages/backend/lib/pairing-tuning.mjs'

// A refusal is a message the host already decided to send; it crosses one
// mailbox write and one poll (PAIRING_POLL_MS is 15 s). 20 s covers that and is
// still nowhere near the 120 s deadline a swallowed refusal decays into — the
// gap between the two is what makes this a regression test rather than a
// timing preference.
export const LOSER_SETTLE_MS = 20_000

// Log lines that mean "this peer's join ended badly", host side or guest side.
const JOIN_FAILURE_LINE = /joinViaInvite failed|Pairing candidate denied|Failed to (accept|deny) (invite candidate|pairing candidate)|join-error/i

// Fallback only — used when a peer is too old to attach a structured reason.
// Every slug here is a JOIN_REASON value so the row speaks one vocabulary
// whichever channel it read.
const JOIN_FAILURE_SIGNATURES = [
    [/invite (was |is )?(already |fully )?(used|spent|exhausted)|no uses remaining/i, JOIN_REASON.INVITE_USED],
    [/expired/i, JOIN_REASON.INVITE_EXPIRED],
    [/rejected|refused|not writable|only the owner|rotated epoch/i, JOIN_REASON.REJECTED],
    [/empty or invalid|discovery key|bad invite/i, JOIN_REASON.INVITE_INVALID],
    [/incomplete credentials|no epoch key/i, JOIN_REASON.INCOMPLETE],
    [/cancelled|canceled/i, JOIN_REASON.CANCELLED],
    [/timed out|timeout/i, JOIN_REASON.TIMEOUT],
]

// Reasons that are a clock running out, not a peer answering. A loser reporting
// one of these has NOT been refused — it has been ignored, which is precisely
// the `candidate.close()` symptom. NO_NETWORK belongs here too: it is only ever
// derived from a timeout (refineTimeoutReason).
const DEADLINE_REASONS = new Set([JOIN_REASON.TIMEOUT, JOIN_REASON.NO_NETWORK])

// Machine-readable but content-free. A joiner that lost a race for a single-use
// invite has a specific reason waiting for it; 'unknown' means nobody named it.
const UNINFORMATIVE_REASONS = new Set([JOIN_REASON.UNKNOWN, 'unclassified'])

// The whole published vocabulary. Importing JOIN_REASON is not by itself enough
// to make a renamed slug break this row — the deadline/uninformative sets only
// name a handful of members, so any string outside them used to read as a
// perfectly good answer. Checking membership is what actually ties the row to
// the backend's wire contract.
const KNOWN_REASONS = new Set(Object.values(JOIN_REASON))

// What losing a race for a single-use invite means, precisely: the host's
// invite-policy calls it 'exhausted' and denyStatusForReason maps that to
// DENY_STATUS.USED, which a guest decodes as INVITE_USED. Any other named
// reason means the host answered a different question than the one asked, and
// the user-visible copy will be wrong even though nothing timed out.
export const EXPECTED_LOSER_REASON = JOIN_REASON.INVITE_USED

export function isDeadlineReason(reason) {
    return DEADLINE_REASONS.has(reason)
}

export function isUninformativeReason(reason) {
    return UNINFORMATIVE_REASONS.has(reason)
}

export function isKnownReason(reason) {
    return KNOWN_REASONS.has(reason)
}

export function classifyJoinFailure(text) {
    const haystack = String(text ?? '')
    for (const [pattern, slug] of JOIN_FAILURE_SIGNATURES) {
        if (pattern.test(haystack)) return slug
    }
    return haystack.trim() ? 'unclassified' : null
}

// Pull the join verdict out of an instance's stderr log stream.
//
// stderr is the only channel that carries it today: the headless `join` op
// answers `{}` whatever happens, and `dump` has no join-failure field, so the
// backend's `join-error` broadcast never reaches an operator. @listam/logging
// writes one JSON object per line ({ts, level, app, message, details}) and the
// join failure ships its reason as a detail — that structured slug is the
// answer, and the message regex is only a fallback for older peers.
//
// Non-JSON lines (a bare stack trace, runtime noise) are skipped rather than
// guessed at: a reason invented from unstructured text would defeat the point
// of asserting the reason is machine-readable.
export function readJoinFailure(instance) {
    const raw = instance?.service?.stderr ?? ''
    for (const line of raw.split('\n').reverse()) {
        if (!line.startsWith('{')) continue
        let entry = null
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        const message = String(entry?.message ?? '')
        if (!JOIN_FAILURE_LINE.test(message)) continue

        const details = Array.isArray(entry.details) ? entry.details : []
        const structured = details.find((detail) => typeof detail?.reason === 'string')?.reason ?? null
        // @listam/logging reduces an Error to {name, message}, so the cause text
        // rides in a detail object of its own, redacted.
        const text = [message, ...details.map((detail) => (typeof detail === 'string' ? detail : detail?.message ?? ''))]
            .filter(Boolean)
            .join(' ')
        return {
            reason: structured ?? classifyJoinFailure(text),
            structured: Boolean(structured),
            message: text.trim().slice(0, 300),
        }
    }
    return null
}
