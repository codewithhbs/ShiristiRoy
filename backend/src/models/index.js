import mongoose from 'mongoose';

// --- Blog ---
const blogSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, index: true },
  title: { type: String, required: true },
  excerpt: { type: String, maxlength: 320 },
  content: { type: String, required: true }, // markdown or HTML
  coverImage: { url: String, publicId: String, alt: String },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tags: [{ type: String, index: true }],
  category: String,
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  readingTimeMin: Number,
  publishedAt: Date,
  seo: { metaTitle: String, metaDescription: String, ogImage: String, keywords: [String], canonicalUrl: String },
  views: { type: Number, default: 0 },
}, { timestamps: true });
blogSchema.index({ status: 1, publishedAt: -1 });
export const Blog = mongoose.model('Blog', blogSchema);

// --- Testimonial ---
const testimonialSchema = new mongoose.Schema({
  authorName: { type: String, required: true },
  authorAvatar: { url: String, publicId: String },
  rating: { type: Number, min: 1, max: 5, default: 5 },
  text: { type: String, required: true, maxlength: 1000 },
  therapist: { type: mongoose.Schema.Types.ObjectId, ref: 'Therapist' },
  isPublished: { type: Boolean, default: false, index: true },
  isFeatured: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
}, { timestamps: true });
export const Testimonial = mongoose.model('Testimonial', testimonialSchema);

// --- Notification ---
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['booking_confirmed', 'booking_cancelled', 'reminder', 'system', 'payment'], required: true },
  title: String,
  body: String,
  link: String,
  meta: mongoose.Schema.Types.Mixed,
  isRead: { type: Boolean, default: false, index: true },
}, { timestamps: true });
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
export const Notification = mongoose.model('Notification', notificationSchema);

// --- SEO Metadata (per page) ---
const seoSchema = new mongoose.Schema({
  pageKey: { type: String, required: true, unique: true, index: true }, // 'home', 'about', 'services'...
  title: String,
  description: String,
  keywords: [String],
  ogImage: String,
  canonicalUrl: String,
  jsonLd: mongoose.Schema.Types.Mixed,
  noindex: { type: Boolean, default: false },
}, { timestamps: true });
export const SeoMetadata = mongoose.model('SeoMetadata', seoSchema);

// --- Settings (singleton-ish CMS) ---
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: mongoose.Schema.Types.Mixed,
  group: String, // 'theme', 'contact', 'social', 'business'
}, { timestamps: true });
export const Settings = mongoose.model('Settings', settingsSchema);

// --- Transaction (payment) ---
const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  provider: { type: String, enum: ['razorpay', 'manual', 'free','qr'], default: 'razorpay' },
  providerOrderId: String,
  providerPaymentId: String,
  intakeForm: String,
  consentForm: String,

  consentDone: String,
  consentStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  consentRejectReason: String,
  providerSignature: String,
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['created', 'paid', 'failed', 'refunded'], default: 'created', index: true },
  refund: { id: String, amount: Number, at: Date, reason: String },
  meta: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
export const Transaction = mongoose.model('Transaction', transactionSchema);

// --- Audit log ---
const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: String,    // 'user.create', 'booking.cancel'
  entity: String,    // 'User', 'Appointment'
  entityId: mongoose.Schema.Types.ObjectId,
  diff: mongoose.Schema.Types.Mixed,
  ip: String,
  userAgent: String,
}, { timestamps: true });
auditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
export const AuditLog = mongoose.model('AuditLog', auditSchema);

// --- Contact submission ---
const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: String,
  subject: String,
  message: { type: String, required: true },
  status: { type: String, enum: ['new', 'read', 'replied', 'spam'], default: 'new', index: true },
  ip: String,
}, { timestamps: true });
export const ContactMessage = mongoose.model('ContactMessage', contactSchema);

// --- FAQ ---
const faqSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  category: { type: String, default: 'general' },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
export const Faq = mongoose.model('Faq', faqSchema);
