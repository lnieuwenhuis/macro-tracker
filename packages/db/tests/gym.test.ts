import {
  createGymSlot,
  deleteGymSlot,
  getGymHomeSummary,
  getGymPageData,
  inviteGymBuddy,
  removeGymBuddy,
  respondGymBuddyInvite,
  setGymSlotStatus,
  updateGymSlot,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../src";
import { createTestDatabase } from "../src/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 2026-09-07 is a Monday, inside gym.rs's ±400-day status window from today.
const MONDAY = "2026-09-07";
const TUESDAY = "2026-09-08";

describe("gym schedule sharing", () => {
  let runtime: DatabaseRuntime;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    runtime = await createTestDatabase();
    const alice = await upsertUserFromShooProfile({
      pairwiseSub: "ps_gym_alice",
      email: "alice@example.com",
      displayName: "Alice",
    });
    const bob = await upsertUserFromShooProfile({
      pairwiseSub: "ps_gym_bob",
      email: "bob@example.com",
      displayName: null,
    });
    aliceId = alice.id;
    bobId = bob.id;
  });

  afterEach(async () => {
    await runtime.close();
  });

  async function makeBuddies(requesterId: string, addresseeEmail: string) {
    const invite = await inviteGymBuddy(requesterId, addresseeEmail);
    expect(invite.result).toBe("invited");
    const page = await getGymPageData(
      addresseeEmail === "bob@example.com" ? bobId : aliceId,
      MONDAY,
    );
    const incoming = page.buddies.pendingIncoming.find(
      (entry) => entry.id === invite.id,
    );
    expect(incoming).toBeTruthy();
    await respondGymBuddyInvite(
      addresseeEmail === "bob@example.com" ? bobId : aliceId,
      invite.id,
      true,
    );
    return invite.id;
  }

  it("creates, edits and deletes slots with ownership enforced", async () => {
    const slot = await createGymSlot(aliceId, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 18 * 60 + 30,
    });
    expect(slot.title).toBe("Gym");
    expect(slot.weekday).toBe(1);
    expect(slot.slotDate).toBeNull();

    const updated = await updateGymSlot(aliceId, slot.id, {
      title: "Leg day",
      description: "Squats first",
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 19 * 60,
    });
    expect(updated.title).toBe("Leg day");
    expect(updated.description).toBe("Squats first");
    expect(updated.endMinute).toBe(19 * 60);

    // Recurrence is immutable after creation.
    await expect(
      updateGymSlot(aliceId, slot.id, {
        recurrence: "once",
        slotDate: MONDAY,
        startMinute: 17 * 60,
        endMinute: 19 * 60,
      }),
    ).rejects.toThrow("repeat kind can't be changed");

    await expect(
      updateGymSlot(bobId, slot.id, {
        title: "Hijacked",
        recurrence: "weekly",
        weekday: 1,
        startMinute: 0,
        endMinute: 60,
      }),
    ).rejects.toThrow("Gym slot not found.");
    await expect(deleteGymSlot(bobId, slot.id)).rejects.toThrow(
      "Gym slot not found.",
    );

    await deleteGymSlot(aliceId, slot.id);
    const page = await getGymPageData(aliceId, MONDAY);
    expect(page.slots).toEqual([]);
  });

  it("rejects overnight slots and out-of-range weekdays", async () => {
    await expect(
      createGymSlot(aliceId, {
        recurrence: "weekly",
        weekday: 1,
        startMinute: 22 * 60,
        endMinute: 2 * 60,
      }),
    ).rejects.toThrow("overnight slots are not supported");
    await expect(
      createGymSlot(aliceId, {
        recurrence: "weekly",
        weekday: 8,
        startMinute: 600,
        endMinute: 660,
      }),
    ).rejects.toThrow("Weekday must be between 1 (Monday) and 7 (Sunday).");
    // Ending exactly at midnight is allowed.
    const slot = await createGymSlot(aliceId, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 23 * 60,
      endMinute: 1440,
    });
    expect(slot.endMinute).toBe(1440);
  });

  it("upserts per-date statuses with ownership and occurrence checks", async () => {
    const weekly = await createGymSlot(aliceId, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 600,
      endMinute: 660,
    });

    const set = await setGymSlotStatus(aliceId, weekly.id, MONDAY, "skipped");
    expect(set.status).toBe("skipped");
    const updated = await setGymSlotStatus(aliceId, weekly.id, MONDAY, "done");
    expect(updated.status).toBe("done");

    // The date's weekday must match the slot's weekday.
    await expect(
      setGymSlotStatus(aliceId, weekly.id, TUESDAY, "skipped"),
    ).rejects.toThrow("Gym slot not found for that date.");

    // A buddy cannot write statuses on someone else's slot, even knowing its id.
    await makeBuddies(aliceId, "bob@example.com");
    await expect(
      setGymSlotStatus(bobId, weekly.id, MONDAY, "skipped"),
    ).rejects.toThrow("Gym slot not found for that date.");

    // Far-future dates are rejected (unbounded row growth guard).
    await expect(
      setGymSlotStatus(aliceId, weekly.id, "2031-09-01", "skipped"),
    ).rejects.toThrow("too far away");

    // A one-off slot only accepts its own date.
    const once = await createGymSlot(aliceId, {
      recurrence: "once",
      slotDate: MONDAY,
      startMinute: 700,
      endMinute: 760,
    });
    await setGymSlotStatus(aliceId, once.id, MONDAY, "maybe");
    await expect(
      setGymSlotStatus(aliceId, once.id, TUESDAY, "maybe"),
    ).rejects.toThrow("Gym slot not found for that date.");
  });

  it("drops day statuses when a slot moves to another day, keeps them otherwise", async () => {
    const slot = await createGymSlot(aliceId, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 600,
      endMinute: 660,
    });
    await setGymSlotStatus(aliceId, slot.id, MONDAY, "skipped");

    await updateGymSlot(aliceId, slot.id, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 630,
      endMinute: 690,
    });
    let page = await getGymPageData(aliceId, MONDAY);
    expect(page.day.own[0]?.status).toBe("skipped");

    // Moving back to Monday must NOT resurrect the old skip.
    await updateGymSlot(aliceId, slot.id, {
      recurrence: "weekly",
      weekday: 2,
      startMinute: 630,
      endMinute: 690,
    });
    await updateGymSlot(aliceId, slot.id, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 630,
      endMinute: 690,
    });
    page = await getGymPageData(aliceId, MONDAY);
    expect(page.day.own[0]?.status).toBe("going");
  });

  it("runs the invite lifecycle with decline-as-block semantics", async () => {
    await expect(inviteGymBuddy(aliceId, "alice@example.com")).rejects.toThrow(
      "You can't invite yourself.",
    );
    await expect(inviteGymBuddy(aliceId, "nobody@example.com")).rejects.toThrow(
      "No user with that email is on Macro Tracker.",
    );

    // Email matching is case-insensitive.
    const invite = await inviteGymBuddy(aliceId, "  BOB@example.com ");
    expect(invite.result).toBe("invited");
    await expect(inviteGymBuddy(aliceId, "bob@example.com")).rejects.toThrow(
      "You already invited this user.",
    );

    // Outgoing echoes the typed email; incoming shows the requester's name.
    const alicePage = await getGymPageData(aliceId, MONDAY);
    expect(alicePage.buddies.pendingOutgoing).toEqual([
      { id: invite.id, identifier: "bob@example.com" },
    ]);
    const bobPage = await getGymPageData(bobId, MONDAY);
    expect(bobPage.buddies.pendingIncoming).toEqual([
      { id: invite.id, user: { id: aliceId, name: "Alice" } },
    ]);

    // Bob declines: the row becomes a block only Bob can see and lift.
    await respondGymBuddyInvite(bobId, invite.id, false);
    await expect(inviteGymBuddy(aliceId, "bob@example.com")).rejects.toThrow(
      "You can't invite this user right now.",
    );
    // Alice's stale "Cancel" must NOT delete the block; the error stays neutral about why.
    await expect(removeGymBuddy(aliceId, invite.id)).rejects.toThrow(
      "This invite is no longer available.",
    );
    const bobAfterDecline = await getGymPageData(bobId, MONDAY);
    expect(bobAfterDecline.buddies.declined).toEqual([
      { id: invite.id, user: { id: aliceId, name: "Alice" } },
    ]);
    const aliceAfterDecline = await getGymPageData(aliceId, MONDAY);
    expect(aliceAfterDecline.buddies.declined).toEqual([]);

    await removeGymBuddy(bobId, invite.id);
    const reinvite = await inviteGymBuddy(aliceId, "bob@example.com");
    expect(reinvite.result).toBe("invited");
    await respondGymBuddyInvite(bobId, reinvite.id, true);
    const accepted = await getGymPageData(aliceId, MONDAY);
    // Bob has no display name, so his email is the fallback everywhere.
    expect(accepted.buddies.accepted).toEqual([
      { id: reinvite.id, user: { id: bobId, name: "bob@example.com" } },
    ]);
    await expect(inviteGymBuddy(aliceId, "bob@example.com")).rejects.toThrow(
      "You're already gym buddies with this user.",
    );

    // Either member can end it.
    await removeGymBuddy(bobId, reinvite.id);
    const afterRemoval = await getGymPageData(aliceId, MONDAY);
    expect(afterRemoval.buddies.accepted).toEqual([]);
  });

  it("supports static friend codes without revealing the target's email", async () => {
    // The code is generated on first gym-page access and stays static.
    const bobPage = await getGymPageData(bobId, MONDAY);
    expect(bobPage.friendCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    const bobPageAgain = await getGymPageData(bobId, MONDAY);
    expect(bobPageAgain.friendCode).toBe(bobPage.friendCode);
    const alicePage = await getGymPageData(aliceId, MONDAY);
    expect(alicePage.friendCode).not.toBe(bobPage.friendCode);

    // Codes are random, so an unknown code is not an account oracle the way email is.
    await expect(inviteGymBuddy(aliceId, "ZZZZ-ZZZZ")).rejects.toThrow(
      "No user with that friend code.",
    );

    // Lowercased, dash-separated input resolves to the same stored code.
    const sloppyCode = `${bobPage.friendCode.slice(0, 4).toLowerCase()}-${bobPage.friendCode.slice(4).toLowerCase()}`;
    const invite = await inviteGymBuddy(aliceId, sloppyCode);
    expect(invite.result).toBe("invited");

    // The sent-invites list must echo the CODE, not the email it resolved to.
    const afterInvite = await getGymPageData(aliceId, MONDAY);
    expect(afterInvite.buddies.pendingOutgoing).toEqual([
      { id: invite.id, identifier: bobPage.friendCode },
    ]);
    expect(JSON.stringify(afterInvite.buddies.pendingOutgoing)).not.toContain(
      "bob@example.com",
    );

    // The rest of the lifecycle is identical to email invites.
    await respondGymBuddyInvite(bobId, invite.id, true);
    const accepted = await getGymPageData(aliceId, MONDAY);
    expect(accepted.buddies.accepted).toHaveLength(1);
  });

  it("auto-accepts when both users invite each other", async () => {
    await inviteGymBuddy(aliceId, "bob@example.com");
    const reverse = await inviteGymBuddy(bobId, "alice@example.com");
    expect(reverse.result).toBe("accepted");
    const page = await getGymPageData(aliceId, MONDAY);
    expect(page.buddies.accepted).toHaveLength(1);
    expect(page.buddies.pendingOutgoing).toEqual([]);
  });

  it("shares day schedules with buddies but never the description", async () => {
    await createGymSlot(aliceId, {
      title: "Secret session",
      description: "Private notes",
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 18 * 60,
    });
    await makeBuddies(aliceId, "bob@example.com");

    const bobPage = await getGymPageData(bobId, MONDAY);
    expect(bobPage.day.buddies).toHaveLength(1);
    const aliceEntry = bobPage.day.buddies[0]!;
    expect(aliceEntry.user).toEqual({ id: aliceId, name: "Alice" });
    expect(aliceEntry.slots).toHaveLength(1);
    const sharedSlot = aliceEntry.slots[0]!;
    expect(sharedSlot.title).toBe("Secret session");
    expect(sharedSlot.status).toBe("going");
    // The buddy projection must not carry the private description key at all.
    expect(Object.keys(sharedSlot)).not.toContain("description");

    const alicePage = await getGymPageData(aliceId, MONDAY);
    expect(alicePage.day.own[0]?.description).toBe("Private notes");
    // Tuesday resolves nothing for a Monday slot.
    const tuesday = await getGymPageData(aliceId, TUESDAY);
    expect(tuesday.day.own).toEqual([]);
  });

  it("computes overlaps with the 30-minute boundary and status rules", async () => {
    const aliceSlot = await createGymSlot(aliceId, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 18 * 60 + 30,
    });
    // Bob's slot overlaps Alice's by exactly 30 minutes, the counting boundary.
    await createGymSlot(bobId, {
      recurrence: "once",
      slotDate: MONDAY,
      startMinute: 18 * 60,
      endMinute: 19 * 60,
    });

    // No overlap before they are buddies.
    let summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.overlaps).toEqual([]);

    await makeBuddies(aliceId, "bob@example.com");
    summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.overlaps).toHaveLength(1);
    expect(summary.overlaps[0]).toEqual({
      buddy: { id: bobId, name: "bob@example.com" },
      windows: [
        { startMinute: 18 * 60, endMinute: 18 * 60 + 30, tentative: false },
      ],
      tentative: false,
    });

    // 29 shared minutes must NOT count: shrink Alice's slot by one minute.
    await updateGymSlot(aliceId, aliceSlot.id, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 18 * 60 + 29,
    });
    summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.overlaps).toEqual([]);

    await updateGymSlot(aliceId, aliceSlot.id, {
      recurrence: "weekly",
      weekday: 1,
      startMinute: 17 * 60,
      endMinute: 18 * 60 + 30,
    });
    // A `maybe` status on either side makes the overlap tentative.
    await setGymSlotStatus(aliceId, aliceSlot.id, MONDAY, "maybe");
    summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.overlaps[0]?.tentative).toBe(true);

    // A `skipped` status removes the overlap entirely.
    await setGymSlotStatus(aliceId, aliceSlot.id, MONDAY, "skipped");
    summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.overlaps).toEqual([]);
  });

  it("keeps the home summary cheap and counts pending invites", async () => {
    let summary = await getGymHomeSummary(bobId, MONDAY);
    expect(summary).toEqual({ overlaps: [], pendingInviteCount: 0 });

    await inviteGymBuddy(aliceId, "bob@example.com");
    summary = await getGymHomeSummary(bobId, MONDAY);
    expect(summary.pendingInviteCount).toBe(1);
    // The inviter's own badge count stays untouched.
    summary = await getGymHomeSummary(aliceId, MONDAY);
    expect(summary.pendingInviteCount).toBe(0);
  });
});
