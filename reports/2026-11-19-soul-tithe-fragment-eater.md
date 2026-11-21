---
id: 2026-11-19-soul-tithe-fragment-eater
title: "Sealed Cavern monsters will eat Soul Fragments: an 'eaten' loss with no refund (heads-up for Soul Tithe)"
status: open          # open | fixed | verified | wontfix
severity: minor       # a design change to your system, nothing is broken
reporter: onigensou
assignee: sarunphat
component: conflict-event/soul-tithe
introduced_in:
fixed_in:
---

## What this is

A heads-up, not a bug. Oni approved a new design rule for the Sealed Cavern's random
encounters (the Nox Legion), and it changes one promise of your Soul Tithe. Nothing is
built yet; this tells you before it is.

Design page (all monsters, numbers and notes): https://claude.ai/artifact/YNJFffhKfc9ZM2dc16PiEs
(section "How monsters in this cavern are designed", and the pre-wiring check near the end).

## The rule: Fragment Eater

A few Nox monsters can **eat** a Soul Fragment instead of the party destroying it:

- **Nox Wraith · Devour Soul** (in Crisis, once per round): eats a fragment, heals 30% of its Max HP, gets its turn back.
- **Nox Executioner · Soul Sever** (30 MP, Overflow): eats a fragment and deals poison damage to every player equal to 100% of that fragment's current HP.
- **Nox Executioner · Beheading** (round end, before your Tithe beat): KOs a marked player under 15% of their starting HP; their fragment goes with them.

An eaten fragment **pays no refund**. What it held stays lost **until the battle ends**,
when everything comes back like any other Soul Tithe loss. So your promise that nobody
leaves a battle with a shorter HP bar still holds.

## What it changes in Soul Tithe

Your invariant is "a fragment's Max HP always equals what its owner has lost", and
`onRoundEnd` re-squares fragments against the owner's loss. An eaten fragment breaks
that: the owner has lost HP that no fragment holds. Without a separate record, the next
wound would spawn a new fragment holding the eaten amount too, and the loss would come
back.

The approach Claude proposed (Oni approved the rule; how to store it is your call):

- Keep every current rule. Add an **"eaten" amount on the player** that no fragment holds.
- `onRoundEnd` re-squares a fragment against (owner's loss − eaten), not the whole loss.
- Battle end restores the eaten amount with everything else.
- The HUD's burned-HP bar could show the eaten part differently (for example grey ash instead of soul-fire), so players can tell "kill the fragment to get it back" from "gone this fight".

Guardrails on the monster side, so it stays fair:

- A fragment can't be eaten until it has Called once (the party always gets one full round to kill it).
- Only the Wraith and the Executioner eat, and never in the same encounter group.

## Also touching your system

- **Nox Priest · Soul Siphon:** whenever a Soul Fragment is destroyed by anyone (a party kill, Devour Soul, Soul Sever, a Beheading), the Priest gains 30 MP at once. It would listen to `onObjectDestroyed`; eating must go through the same path so it fires. Fragments vanishing at battle end don't count.
- **Nox Wraith · Soul Ripper:** its damage is locked at once (Max HP drops by the damage and it goes straight into the target's fragment) instead of waiting for the round-end lock.

## Notes

- 2026-11-19 (Oni / Claude): rule approved by Oni. No code yet; this goes in with the Nox Legion first wiring pass.
