import * as bookingSvc from '../services/booking.service.js';
import * as slotSvc from '../services/slot.service.js';
import Appointment from '../models/Appointment.js';
import { asyncHandler, fail, ok } from '../utils/apiError.js';
import { Slot } from '../models/Slot.js';
import { sendEmail, templates } from '../services/email.service.js';

export const listAvailableSlots = asyncHandler(async (req, res) => {
  const { therapistId, from, to, mode, service } = req.query;
  const slots = await slotSvc.listAvailableSlots({
    therapistId, from: new Date(from), to: new Date(to), mode, service,
  });
  ok(res, slots);
});

export const adminListSlots = asyncHandler(async (req, res) => {
  const { therapistId, from, to, mode, service, status, page = 1, limit = 20 } = req.query;

  const query = {};
  if (therapistId) query.therapist = therapistId;
  if (service) query.service = service;
  if (mode) query.mode = mode;
  if (status && status !== 'all') query.status = status;
  if (from || to) {
    query.startAt = {};
    if (from) query.startAt.$gte = new Date(from);
    if (to) query.startAt.$lte = new Date(to);
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [items, total] = await Promise.all([
    Slot.find(query)
      .populate('appointment', 'bookingCode')
      .populate('service', 'name')
      .populate({ path: 'therapist', populate: { path: 'user', select: 'name' } })
      .sort({ startAt: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Slot.countDocuments(query),
  ]);

  ok(res, {
    items,
    pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
  });
});

export const checkSelectedSlot = asyncHandler(async (req, res) => {
  const { slotId, therapistId, mode, service } = req.body;
  const slot = await slotSvc.checkSelectedSlot({ slotId, therapistId, mode, service });
  ok(res, slot);
});

export const holdSlot = asyncHandler(async (req, res) => {
  const slot = await bookingSvc.holdSlot({ slotId: req.params.slotId, userId: req.user.id });
  ok(res, slot, 'Slot held');
});

export const releaseHold = asyncHandler(async (req, res) => {
  await bookingSvc.releaseHold({ slotId: req.params.slotId, userId: req.user.id });
  ok(res, null, 'Hold released');
});

// Step 1: hold slot + create Razorpay order
// POST /bookings/initiate-payment
// body: { slotId, serviceId, mode, amount, intake }
export const initiatePayment = asyncHandler(async (req, res) => {
  try {
    const { slotId, serviceId, mode, amount, intake } = req.body;
    const result = await bookingSvc.initiatePayment({
      userId: req.user.id,
      slotId,
      serviceId,
      mode,
      amount,
      intake,
    });
    ok(res, result, 'Payment initiated', 201);
  } catch (err) {
    console.error(err)
  }
});

export const verifyPayment = asyncHandler(async (req, res) => {
  const { slotId, txnId, razorpay_payment_id, razorpay_signature } = req.body;
  const result = await bookingSvc.confirmPayment({
    userId: req.user.id,
    slotId,
    txnId,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  ok(res, result, 'Booking confirmed', 201);
});

export const paymentViaStaticQrAndUtrNumber = asyncHandler(async (req, res) => {
  const { slotId, serviceId, mode, amount, intake, utr } = req.body;
  const result = await bookingSvc.paymentViaQr({
    userId: req.user.id,
    slotId,
    utr,
    serviceId,
    mode,
    amount,
    intake,
  });
  ok(res, result, 'Payment success', 201);

})

export const myAppointments = asyncHandler(async (req, res) => {

  const list = await Appointment.find({ user: req.user.id })
    .populate('therapist', 'slug title')
    .populate('service', 'name slug')
    .populate('payment', 'status amount providerPaymentId')
    .sort({ startAt: -1 });
  ok(res, list);
});


export const uploadForms = asyncHandler(async (req, res) => {
  const uploaded = req.uploadedFile || null; // { publicId, publicPath, fileName, mimeType }
  const type = req.body?.type; // 'intake' | 'consent'

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    user: req.user.id,
  }).populate('payment').populate('user', 'name email');

  if (!appointment) {
    return fail(res, "Appointment not found", 404);
  }

  const payment = appointment.payment;
  if (!payment) {
    return fail(res, "No payment record for this appointment", 404);
  }

  if (!uploaded) {
    return fail(res, "No file uploaded", 400);
  }
  if (!['intake', 'consent'].includes(type)) {
    return fail(res, "Missing/invalid 'type' — must be 'intake' or 'consent'", 400);
  }

  const wasRejected = payment.consentStatus === 'rejected';
  const previousReason = payment.consentRejectReason;

  if (type === 'intake') {
    payment.intakeForm = uploaded.publicPath;
  } else {
    // consent form file — stored the same way as intake (URL string).
    // consentDone/consentStatus track admin review of that file.
    payment.consentForm = uploaded.publicPath;
    payment.consentDone = true;
    payment.consentStatus = 'pending'; // needs admin review after (re)upload
    payment.consentRejectReason = undefined;
  }

  await payment.save();

  // Let admin know a form is waiting on their review.
  if (process.env.ADMIN_EMAIL) {
    const reviewUrl = process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/admin/appointments` : undefined;
    const mailData = {
      userName: appointment.user?.name || 'A client',
      userEmail: appointment.user?.email || '—',
      bookingCode: appointment.bookingCode,
      startAt: appointment.startAt?.toString(),
      reviewUrl,
    };
    const mail = type === 'intake'
      ? templates.adminIntakeFormUploaded(mailData)
      : (wasRejected
        ? templates.adminConsentReuploaded({ ...mailData, previousReason })
        : templates.adminConsentFormUploaded(mailData));
    await sendEmail({ to: process.env.ADMIN_EMAIL, ...mail }).catch(() => { });
  }

  return ok(res, {
    intakeForm: payment.intakeForm,
    consentForm: payment.consentForm,
    consentDone: payment.consentDone,
    consentStatus: payment.consentStatus,
    uploadedUrl: uploaded.publicPath,
  }, "Forms uploaded successfully");
});


export const singleAppointMent = asyncHandler(async (req, res) => {

  const list = await Appointment.findOne({ _id: req.params.id, user: req.user.id })
    .populate('therapist', 'slug title')
    .populate('service', 'name slug')
    .populate('payment')
    .sort({ startAt: -1 });
  ok(res, list);
});

export const cancel = asyncHandler(async (req, res) => {
  const appt = await bookingSvc.cancelAppointment({
    appointmentId: req.params.id,
    byUserId: req.user.id,
    reason: req.body?.reason,
  });
  ok(res, appt, 'Cancelled');
});

export const reschedule = asyncHandler(async (req, res) => {
  const appt = await bookingSvc.rescheduleAppointment({
    appointmentId: req.params.id,
    newSlotId: req.body.newSlotId,
    userId: req.user.id,
  });
  ok(res, appt, 'Rescheduled');
});

export const adminBlockSlot = asyncHandler(async (req, res) => {
  const slot = await bookingSvc.toggleSlotBlock({ slotId: req.params.slotId });
  ok(res, slot, slot.status === 'blocked' ? 'Slot blocked' : 'Slot unblocked');
});

export const adminUnblockSlot = asyncHandler(async (req, res) => {
  const slot = await bookingSvc.adminUnblockSlot({ slotId: req.params.slotId });
  ok(res, slot, 'Slot unblocked');
});