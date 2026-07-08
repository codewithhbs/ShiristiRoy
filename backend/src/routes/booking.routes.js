import { Router } from 'express';
import * as c from '../controllers/booking.controller.js';
import { authenticate, authorize } from '../middlewares/auth.js';
import { ROLES } from '../models/User.js';
import { validate } from '../middlewares/validate.js';
import { bookingLimiter } from '../middlewares/rateLimit.js';
import { bookingSchemas } from '../validators/schemas.js';
import { multiplePdfUpload, singleFileUpload, singleImageUpload } from '../middlewares/upload.js';

const r = Router();

// public slot listing
r.get('/slots', c.listAvailableSlots);
r.get('/admin/slots', authenticate(), authorize(ROLES.ADMIN), c.adminListSlots);
r.patch('/slots/:slotId', authenticate(), authorize(ROLES.ADMIN), c.adminBlockSlot);


r.post("/check-slot", c.checkSelectedSlot);

// auth required
r.use(authenticate());

r.post('/slots/:slotId/hold', bookingLimiter, c.holdSlot);
r.delete('/slots/:slotId/hold', c.releaseHold);

// r.post('/', bookingLimiter, validate(bookingSchemas.book), c.initiatePayment);
r.post('/initiate-payment', bookingLimiter, c.initiatePayment);

r.post('/qr-payment', bookingLimiter, c.paymentViaStaticQrAndUtrNumber);

r.post('/verify-payment', c.verifyPayment);
r.post('/me/:id/documents', singleFileUpload('file'), c.uploadForms);



r.get('/me', c.myAppointments);
r.get('/me/:id', c.singleAppointMent);


r.patch('/:id/cancel', c.cancel);
r.patch('/:id/reschedule', validate(bookingSchemas.reschedule), c.reschedule);

export default r;
