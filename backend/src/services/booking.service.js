import mongoose from 'mongoose';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Slot, SlotStatus } from '../models/Slot.js';
import Appointment, { APPOINTMENT_STATUS } from '../models/Appointment.js';
import { Notification, Transaction } from '../models/index.js';
import Therapist from '../models/Therapist.js';
import User from '../models/User.js';
import { redlock, redis } from '../config/redis.js';
import { ApiError } from '../utils/apiError.js';
import { sendEmail, templates } from './email.service.js';
import logger from '../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const HOLD_TTL_MS = Number(process.env.SLOT_LOCK_TTL_MS || 10_000);
const CANCEL_CUTOFF_HRS = 4;   // cancel blocked within 4 hrs of session
const REFUND_CUTOFF_HRS = 24;  // refund only if 24+ hrs before session
const RESCHEDULE_CUTOFF_HRS = 10; // reschedule blocked within 10 hrs

const rz = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const lockKey = (slotId) => `lock:slot:${slotId}`;
const holdKey = (slotId) => `hold:slot:${slotId}`;
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const hoursUntil = (date) => (new Date(date) - new Date()) / 3_600_000;

// ─── Razorpay Internals ───────────────────────────────────────────────────────

function _verifySignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

async function _createRzOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  return rz.orders.create({
    amount: Math.round(amount * 100), // paise
    currency,
    receipt,
    notes,
  });
}

async function _initiateRzRefund({ providerPaymentId, amount, notes = {} }) {
  return rz.payments.refund(providerPaymentId, {
    amount: Math.round(amount * 100),
    notes,
  });
}

// ─── Hold / Release ───────────────────────────────────────────────────────────

/**
 * Hold slot for user while payment in progress.
 * Redlock + atomic update — expired holds reclaimable.
 */
export async function holdSlot({ slotId, userId, ttlMs = HOLD_TTL_MS }) {
  let lock;

  try {
    lock = await redlock.acquire([lockKey(slotId)], 5000);

    // 1. Check Redis
    const redisHold = await redis.get(holdKey(slotId));

    if (redisHold && redisHold !== userId.toString()) {
      throw new ApiError(409, "Slot is already held by another user.");
    }


    // 2. Check MongoDB
    const slot = await Slot.findById(slotId);

    if (!slot) {
      throw new ApiError(404, "Slot not found");
    }

    const now = new Date();

    const canHold =
      slot.status === SlotStatus.AVAILABLE ||
      (slot.status === SlotStatus.HELD && slot.heldUntil < now);

    if (!canHold) {
      throw new ApiError(409, "Slot not available");
    }

    // 3. Update MongoDB
    slot.status = SlotStatus.HELD;
    slot.heldBy = userId;
    slot.heldUntil = new Date(Date.now() + ttlMs);
    slot.version += 1;

    await slot.save();

    // 4. Update Redis
    await redis.set(
      holdKey(slotId),
      userId.toString(),
      "PX",
      ttlMs
    );

    return slot;
  } finally {
    if (lock) {
      await lock.release().catch(() => { });
    }
  }
}

export async function releaseHold({ slotId, userId }) {
  let lock;
  try {
    lock = await redlock.acquire([lockKey(slotId)], 5_000);
    await Slot.updateOne(
      { _id: slotId, status: SlotStatus.HELD, heldBy: userId },
      {
        $set: { status: SlotStatus.AVAILABLE, heldBy: null, heldUntil: null },
        $inc: { version: 1 },
      },
    );
    await redis.del(holdKey(slotId));
  } finally {
    if (lock) await lock.release().catch(() => { });
  }
}

// ─── Payment Flow ─────────────────────────────────────────────────────────────

/**
 * Step 1 — Hold slot + create Razorpay order + pending appointment stub.
 * Returns { appointment, txn, order } to client for checkout.
 */
export async function initiatePayment({ userId, slotId, serviceId, mode, amount, intake = {} }) {

  // fetch slot for startAt/endAt/therapist
  const slot = await Slot.findById(slotId).lean();
  if (!slot) throw new ApiError(404, 'Slot not found');

  // idempotent: reuse existing pending appointment for same (user, slot)
  const appt = await Appointment.findOneAndUpdate(
    { slot: slotId },
    {
      $setOnInsert: {
        bookingCode: `SR-${code()}`,
        user: userId,
        therapist: slot.therapist,
        service: serviceId,
        slot: slotId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        mode: mode || slot.mode,
        status: APPOINTMENT_STATUS.PENDING,
        intake,
      },
    },
    {
      upsert: true,
      new: true,
    }
  );
  // create Razorpay order
  const rzOrder = await _createRzOrder({
    amount,
    receipt: `appt_${appt._id}`,
    notes: { appointmentId: appt._id.toString(), userId: userId.toString() },
  });

  // persist transaction
  const txn = await Transaction.create({
    user: userId,
    appointment: appt._id,
    provider: 'razorpay',
    providerOrderId: rzOrder.id,
    amount,
    currency: rzOrder.currency,
    status: 'created',
    meta: { rzOrder },
  });

  // link txn to appointment
  appt.payment = txn._id;
  await appt.save();

  return { appointment: appt, txn, order: rzOrder };
}

export async function paymentViaQr({ userId, slotId, serviceId, mode, amount, intake = {}, utr }) {
  // fetch slot for startAt/endAt/therapist
  const slot = await Slot.findById(slotId).lean();
  if (!slot) throw new ApiError(404, 'Slot not found');

  // idempotent: reuse existing pending appointment for same (user, slot)
  const stub = await Appointment.findOneAndUpdate(
    { slot: slotId },
    {
      $setOnInsert: {
        bookingCode: `SR-${code()}`,
        user: userId,
        therapist: slot.therapist,
        service: serviceId,
        slot: slotId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        mode: mode || slot.mode,
        status: APPOINTMENT_STATUS.PENDING,
        intake,
      },
    },
    { upsert: true, new: true },
  );

  const paid = Boolean(utr);

  // persist transaction
  const txn = await Transaction.create({
    user: userId,
    appointment: stub._id,
    provider: 'qr',
    providerOrderId: utr || null,
    providerPaymentId: utr || null,
    amount,
    currency: 'INR',
    status: paid ? 'paid' : 'failed',
    meta: { utr: utr || null },
  });

  // link txn to appointment stub
  stub.payment = txn._id;
  await stub.save();

  // no UTR → failed: release hold, notify, bail
  if (!paid) {
    await releaseHold({ slotId, userId }).catch(() => { });
    const u = await User.findById(userId).catch(() => null);
    if (u?.email) {
      await sendEmail({ to: u.email, ...templates.bookingFailed({ reason: 'QR payment not received (no UTR)' }) }).catch(() => { });
    }
    if (process.env.ADMIN_EMAIL) {
      await sendEmail({ to: process.env.ADMIN_EMAIL, ...templates.adminPaymentFailed({ userEmail: u?.email || userId, reason: 'QR payment not received (no UTR)' }) }).catch(() => { });
    }
    return { appt: null, txn };
  }

  // paid → confirm booking atomically (flips slot BOOKED + appt CONFIRMED)
  const appt = await _confirmBooking({ userId, slotId, txnId: txn._id });
  return { appt, txn };
}
/**
 * Step 2 — Verify Razorpay signature, capture payment, confirm booking.
 * Idempotent on (user, slot).
 */
export async function confirmPayment({ userId, slotId, txnId, paymentId, signature }) {
  // ── 1. verify + mark txn paid ──────────────────────────────────────────────
  const txn = await Transaction.findById(txnId);
  if (!txn) throw new ApiError(404, 'Transaction not found');
  if (txn.status === 'paid') {
    // already confirmed — return existing appointment
    const existing = await Appointment.findOne({ user: userId, slot: slotId });
    if (existing) return { appt: existing, txn };
  }

  const valid = _verifySignature({ orderId: txn.providerOrderId, paymentId, signature });
  if (!valid) {
    txn.status = 'failed';
    await txn.save();
    // release hold on failed payment
    await releaseHold({ slotId, userId }).catch(() => { });
    const failedUser = await User.findById(userId).catch(() => null);
    if (failedUser?.email) {
      await sendEmail({ to: failedUser.email, ...templates.bookingFailed({ reason: 'signature verification failed' }) }).catch(() => { });
    }
    if (process.env.ADMIN_EMAIL) {
      await sendEmail({ to: process.env.ADMIN_EMAIL, ...templates.adminPaymentFailed({ userEmail: failedUser?.email || userId, reason: 'signature verification failed' }) }).catch(() => { });
    }
    throw new ApiError(400, 'Payment verification failed');
  }

  txn.providerPaymentId = paymentId;
  txn.providerSignature = signature;
  txn.status = 'paid';
  await txn.save();

  // ── 2. confirm booking atomically ──────────────────────────────────────────
  const appt = await _confirmBooking({ userId, slotId, txnId: txn._id });
  return { appt, txn };
}

/**
 * Internal — atomically flip slot BOOKED + appointment CONFIRMED.
 * Called only after payment verified.
 */
async function _confirmBooking({ userId, slotId, txnId }) {
  // dedup
  const existing = await Appointment.findOne({
    user: userId,
    slot: slotId,
    status: { $in: [APPOINTMENT_STATUS.CONFIRMED, APPOINTMENT_STATUS.PENDING] },
  });

  let lock;
  try {
    lock = await redlock.acquire([lockKey(slotId)], 6_000);
    const session = await mongoose.startSession();
    let appointment;
    try {
      await session.withTransaction(async () => {
        const slot = await Slot.findOneAndUpdate(
          {
            _id: slotId,
            $or: [
              { status: SlotStatus.AVAILABLE },
              { status: SlotStatus.HELD, heldBy: userId },
              { status: SlotStatus.HELD, heldUntil: { $lt: new Date() } },
            ],
          },
          {
            $set: { status: SlotStatus.BOOKED, heldBy: null, heldUntil: null },
            $inc: { version: 1 },
          },
          { new: true, session },
        );
        if (!slot) throw new ApiError(409, 'Slot already booked or unavailable');

        if (existing) {
          existing.status = APPOINTMENT_STATUS.CONFIRMED;
          existing.payment = txnId;
          await existing.save({ session });
          await Slot.updateOne({ _id: slot._id }, { $set: { appointment: existing._id } }, { session });
          appointment = existing;
        } else {
          const therapist = await Therapist.findById(slot.therapist).session(session);
          if (!therapist) throw new ApiError(404, 'Therapist not found');

          const [apptDoc] = await Appointment.create([{
            bookingCode: `SR-${code()}`,
            user: userId,
            therapist: slot.therapist,
            slot: slot._id,
            startAt: slot.startAt,
            endAt: slot.endAt,
            mode: slot.mode,
            status: APPOINTMENT_STATUS.CONFIRMED,
            payment: txnId,
          }], { session });
          appointment = apptDoc;
          await Slot.updateOne({ _id: slot._id }, { $set: { appointment: appointment._id } }, { session });
        }
      });
    } finally {
      await session.endSession();
    }

    await redis.del(holdKey(slotId));
    await _afterBook(appointment).catch((e) => logger.error('after-book err', e));
    return appointment;
  } finally {
    if (lock) await lock.release().catch(() => { });
  }
}

// ─── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Cancel appointment.
 * Rules:
 *   < 4 hrs  → blocked
 *   4–24 hrs → allowed, no refund
 *   24+ hrs  → allowed + auto Razorpay refund
 */
export async function cancelAppointment({ appointmentId, byUserId, reason }) {
  const appt = await Appointment.findById(appointmentId).populate('payment');
  if (!appt) throw new ApiError(404, 'Appointment not found');

  if ([APPOINTMENT_STATUS.CANCELLED, APPOINTMENT_STATUS.COMPLETED].includes(appt.status))
    throw new ApiError(400, `Cannot cancel a ${appt.status} appointment`);

  const hrs = hoursUntil(appt.startAt);
  if (hrs < CANCEL_CUTOFF_HRS)
    throw new ApiError(400, `Cancellation not allowed within ${CANCEL_CUTOFF_HRS} hours of session`);

  const refundEligible = hrs >= REFUND_CUTOFF_HRS;

  let lock;
  try {
    lock = await redlock.acquire([lockKey(appt.slot.toString())], 5_000);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        appt.status = APPOINTMENT_STATUS.CANCELLED;
        appt.cancellation = { at: new Date(), by: byUserId, reason, refundEligible };
        await appt.save({ session });

        await Slot.updateOne(
          { _id: appt.slot },
          {
            $set: { status: SlotStatus.AVAILABLE, appointment: null, heldBy: null, heldUntil: null },
            $inc: { version: 1 },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  } finally {
    if (lock) await lock.release().catch(() => { });
  }

  // refund outside tx
  if (refundEligible && appt.payment) {
    await _processRefund({
      txn: appt.payment,
      amount: appt.payment?.amount,
      reason: `Cancellation by user — ${reason || 'no reason'}`,
    }).catch((e) => logger.error('refund error on cancel', e));
  }

  // notify
  const user = await User.findById(appt.user);
  if (user?.email) {
    await sendEmail({
      to: user.email,
      ...templates.bookingCancelled({
        bookingCode: appt.bookingCode,
        startAt: appt.startAt.toString(),
        refundEligible,
      }),
    }).catch(() => { });
  }

  return appt;
}

// ─── Reschedule ───────────────────────────────────────────────────────────────

/**
 * Reschedule appointment to new slot.
 * Rule: blocked within 10 hrs of original session.
 * No extra charge — payment stays linked to appointment.
 */
export async function rescheduleAppointment({ appointmentId, newSlotId, userId }) {
  const appt = await Appointment.findById(appointmentId);
  if (!appt) throw new ApiError(404, 'Appointment not found');
  if (appt.user.toString() !== userId.toString()) throw new ApiError(403, 'Not your appointment');
  if ([APPOINTMENT_STATUS.CANCELLED, APPOINTMENT_STATUS.COMPLETED].includes(appt.status))
    throw new ApiError(400, 'Cannot reschedule this appointment');

  const hrs = hoursUntil(appt.startAt);
  if (hrs < RESCHEDULE_CUTOFF_HRS)
    throw new ApiError(400, `Reschedule not allowed within ${RESCHEDULE_CUTOFF_HRS} hours of session`);

  const oldSlotId = appt.slot;
  let lock;
  try {
    lock = await redlock.acquire([lockKey(newSlotId), lockKey(oldSlotId.toString())], 6_000);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const newSlot = await Slot.findOneAndUpdate(
          { _id: newSlotId, status: SlotStatus.AVAILABLE },
          {
            $set: { status: SlotStatus.BOOKED, appointment: appt._id },
            $inc: { version: 1 },
          },
          { new: true, session },
        );
        if (!newSlot) throw new ApiError(409, 'New slot not available');

        await Slot.updateOne(
          { _id: oldSlotId },
          {
            $set: { status: SlotStatus.AVAILABLE, appointment: null },
            $inc: { version: 1 },
          },
          { session },
        );

        appt.reschedule = { previousSlot: oldSlotId, at: new Date() };
        appt.slot = newSlot._id;
        appt.startAt = newSlot.startAt;
        appt.endAt = newSlot.endAt;
        appt.status = APPOINTMENT_STATUS.CONFIRMED;
        await appt.save({ session });
      });
    } finally {
      await session.endSession();
    }
  } finally {
    if (lock) await lock.release().catch(() => { });
  }

  return appt;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export async function toggleSlotBlock({ slotId }) {
  const slot = await Slot.findById(slotId);
  if (!slot) throw new ApiError(404, 'Slot not found');
  if (slot.status === SlotStatus.BOOKED) throw new ApiError(400, 'Booked slot cannot be blocked');

  slot.status = slot.status === SlotStatus.BLOCKED ? SlotStatus.AVAILABLE : SlotStatus.BLOCKED;
  await slot.save();
  return slot;
}

export async function adminUnblockSlot({ slotId }) {
  const slot = await Slot.findById(slotId);
  if (!slot) throw new ApiError(404, 'Slot not found');
  if (slot.status !== SlotStatus.BLOCKED) throw new ApiError(400, 'Slot is not blocked');
  slot.status = SlotStatus.AVAILABLE;
  await slot.save();
  return slot;
}

// ─── Refund Helper ────────────────────────────────────────────────────────────

async function _processRefund({ txn, amount, reason }) {
  // txn may be populated doc or just ObjectId — handle both
  const txnDoc = txn?._id
    ? txn
    : await Transaction.findById(txn);

  if (!txnDoc) throw new ApiError(404, 'Transaction not found');
  if (txnDoc.status !== 'paid') throw new ApiError(400, 'Cannot refund unpaid transaction');

  const refundAmt = amount ?? txnDoc.amount;

  const rzRefund = await _initiateRzRefund({
    providerPaymentId: txnDoc.providerPaymentId,
    amount: refundAmt,
    notes: { reason },
  });

  txnDoc.status = 'refunded';
  txnDoc.refund = { id: rzRefund.id, amount: refundAmt, at: new Date(), reason };
  await txnDoc.save();
  return txnDoc;
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

/**
 * Cron: reclaim expired holds → AVAILABLE.
 */
export async function sweepExpiredHolds() {
  const res = await Slot.updateMany(
    { status: SlotStatus.HELD, heldUntil: { $lt: new Date() } },
    {
      $set: { status: SlotStatus.AVAILABLE, heldBy: null, heldUntil: null },
      $inc: { version: 1 },
    },
  );
  if (res.modifiedCount) logger.info(`Released ${res.modifiedCount} expired holds`);
  return res.modifiedCount;
}

// ─── After-book Side Effects ──────────────────────────────────────────────────

async function _afterBook(appointment) {
  const [user, therapist] = await Promise.all([
    User.findById(appointment.user),
    Therapist.findById(appointment.therapist).populate('user', 'name'),
  ]);

  await Notification.create({
    user: appointment.user,
    type: 'booking_confirmed',
    title: 'Booking confirmed',
    body: `Your session is on ${appointment.startAt.toISOString()}`,
    link: `/dashboard/appointments/${appointment._id}`,
  });

  if (user?.email) {
    await sendEmail({
      to: user.email,
      ...templates.bookingConfirmed({
        therapistName: therapist?.user?.name || 'Srishti Roy',
        startAt: appointment.startAt.toString(),
        bookingCode: appointment.bookingCode,
        mode: appointment.mode,
        meetingUrl: appointment.meeting?.url,
      }),
    });
  }

  if (process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      ...templates.adminNewBooking({
        userName: user?.name || 'Client',
        userEmail: user?.email || '—',
        therapistName: therapist?.user?.name || 'Srishti Roy',
        startAt: appointment.startAt.toString(),
        bookingCode: appointment.bookingCode,
      }),
    }).catch(() => { });
  }
}