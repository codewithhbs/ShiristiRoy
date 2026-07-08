'use client';
import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  Loader2, ChevronLeft, ChevronRight, Check,
  Calendar, Clock, Monitor, MapPin,
  HeartHandshake, Sparkles, Waves, FileText,
  Download, Upload, CreditCard, ShieldCheck,
  BookOpen, Home, AlertCircle, QrCode
} from 'lucide-react';
import { serviceApi, slotApi, bookingApi, type Service, type Slot } from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';
import { formatDate, formatTime } from '@/lib/utils';
import { toast } from '@/components/ui/Toaster';
import Link from 'next/link';

/* ─── Types & Constants ──────────────────────────────────────────── */

type Step = 'service' | 'slot' | 'intake' | 'payment' | 'forms' | 'done';

/**
 * PAYMENT_MODE — code-level switch. NOT user selectable.
 * 'qr'  → static QR + manual UTR (current)
 * 'rzp' → Razorpay checkout (flip to this once RZP account live)
 */
const PAYMENT_MODE: 'rzp' | 'qr' = 'qr';

const THERAPIST_ID = process.env.NEXT_PUBLIC_THERAPIST_ID ?? '';
const ENV_SERVICE_ID = process.env.NEXT_PUBLIC_SERVICE_ID ?? '';
const RZ_KEY = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '';
const STATIC_QR_URL = process.env.NEXT_PUBLIC_STATIC_QR_URL ?? '/payment-qr.jpeg';
const UPI_ID = process.env.NEXT_PUBLIC_UPI_ID ?? '';

// Intake + consent form PDF URL — replace with real hosted URL
const INTAKE_FORM_URL = '/assets/IntakeForm.docx';
const CONSENT_FORM_URL = '/PsychotherapyInformedConsent-S.Roy.docx';

const ALL_STEPS: { key: Step; label: string; icon: React.ReactNode }[] = [
  { key: 'service', label: 'Service', icon: <HeartHandshake size={15} /> },
  { key: 'slot', label: 'Date & Time', icon: <Calendar size={15} /> },
  { key: 'intake', label: 'About You', icon: <BookOpen size={15} /> },
  { key: 'payment', label: 'Payment', icon: <CreditCard size={15} /> },
  { key: 'forms', label: 'Forms', icon: <FileText size={15} /> },
];

/* ─── Razorpay loader ─────────────────────────────────────────────── */

function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function groupByDate(slots: Slot[]) {
  const map: Record<string, Slot[]> = {};
  for (const s of slots) {
    const d = s.startAt.split('T')[0];
    if (!map[d]) map[d] = [];
    map[d].push(s);
  }
  return map;
}

/* ─── Shared UI ──────────────────────────────────────────────────── */

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 20,
      border: '1px solid rgba(155,142,196,0.14)',
      padding: '30px 28px',
      boxShadow: '0 4px 32px rgba(155,142,196,0.08)',
      position: 'relative',
      overflow: 'hidden',
      ...style,
    }}>
      {children}
    </div>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 4,
      fontSize: 13, color: '#9ba0ae', background: 'none', border: 'none',
      cursor: 'pointer', marginBottom: 22, padding: '4px 0', fontFamily: 'inherit',
      transition: 'color 0.2s',
    }}
      onMouseEnter={e => (e.currentTarget.style.color = '#9b8ec4')}
      onMouseLeave={e => (e.currentTarget.style.color = '#9ba0ae')}
    >
      <ChevronLeft size={15} /> Back
    </button>
  );
}

function PrimaryBtn({ onClick, disabled, loading, children, style }: {
  onClick?: () => void; disabled?: boolean; loading?: boolean;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{
      width: '100%', padding: '14px 24px',
      background: disabled || loading
        ? 'rgba(155,142,196,0.3)'
        : 'linear-gradient(135deg,#9b8ec4,#7b96b2)',
      color: '#fff', border: 'none', borderRadius: 14,
      fontSize: 15, fontWeight: 600, cursor: disabled || loading ? 'not-allowed' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      fontFamily: 'inherit', letterSpacing: '0.02em', transition: 'all 0.25s ease',
      boxShadow: disabled || loading ? 'none' : '0 4px 20px rgba(155,142,196,0.32)',
      ...style,
    }}
      onMouseEnter={e => { if (!disabled && !loading) (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
    >
      {loading
        ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Please wait…</>
        : children}
    </button>
  );
}

const fieldStyle: React.CSSProperties = {
  width: '100%', border: '1.5px solid rgba(155,142,196,0.22)',
  borderRadius: 12, padding: '12px 16px', fontSize: 14,
  fontFamily: 'inherit', color: '#2d3142', background: '#faf7f2',
  outline: 'none', resize: 'none' as const, transition: 'border-color 0.2s',
  boxSizing: 'border-box' as const,
};

/* ─── Progress Bar ───────────────────────────────────────────────── */

function ProgressBar({ step, hasServiceStep }: { step: Step; hasServiceStep: boolean }) {
  const visible = hasServiceStep ? ALL_STEPS : ALL_STEPS.filter(s => s.key !== 'service');
  const idx = visible.findIndex(s => s.key === step);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, marginBottom: 36 }}>
      {visible.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: done ? '#7a9e7e' : active ? '#9b8ec4' : 'rgba(155,142,196,0.1)',
                color: done || active ? '#fff' : '#9ba0ae',
                border: active ? '2px solid #c4b8e8' : '2px solid transparent',
                transition: 'all 0.3s ease',
                boxShadow: active ? '0 0 0 4px rgba(155,142,196,0.15)' : 'none',
              }}>
                {done ? <Check size={15} /> : s.icon}
              </div>
              <span style={{
                fontSize: 10, letterSpacing: '0.04em', fontWeight: active ? 600 : 400,
                color: active ? '#6b5ea8' : '#b0b8c4', display: 'none',
              }} className="step-label">{s.label}</span>
            </div>
            {i < visible.length - 1 && (
              <div style={{
                width: 48, height: 2, margin: '0 3px 14px',
                background: i < idx
                  ? 'linear-gradient(90deg,#7a9e7e,#9b8ec4)'
                  : 'rgba(155,142,196,0.15)',
                borderRadius: 2, transition: 'background 0.4s',
              }} />
            )}
          </div>
        );
      })}
      <style>{`@media(min-width:480px){.step-label{display:block!important}}`}</style>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────────── */

function BookingContent() {
  const { user, hydrated } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /* ── resolve service from env or query ──────────────────────── */
  const queryServiceId = searchParams.get('serviceId') ?? '';
  const resolvedSvcId = queryServiceId || ENV_SERVICE_ID;
  const hasServiceStep = !resolvedSvcId;

  /* ── step persisted in query param ──────────────────────────── */
  const stepFromQuery = (searchParams.get('step') ?? '') as Step;
  const validSteps: Step[] = ['service', 'slot', 'intake', 'payment', 'forms', 'done'];
  const initialStep: Step = validSteps.includes(stepFromQuery)
    ? stepFromQuery
    : hasServiceStep ? 'service' : 'slot';

  const [step, _setStep] = useState<Step>(initialStep);

  const setStep = useCallback((s: Step) => {
    _setStep(s);
    const p = new URLSearchParams(searchParams.toString());
    p.set('step', s);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [searchParams, pathname, router]);

  /* ── state ───────────────────────────────────────────────────── */
  const [services, setServices] = useState<Service[]>([]);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [intake, setIntake] = useState({ primaryConcern: '', prevTherapy: false, notes: '' });
  const [loading, setLoading] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [booking, setBooking] = useState<any>(null);
  const [pendingTxn, setPendingTxn] = useState<any>(null); // { txnId, orderId, amount }
  const [utr, setUtr] = useState(''); // QR mode: UPI transaction reference

  const [from] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString(); });
  const [to] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 15); return d.toISOString(); });

  /* ── load services ───────────────────────────────────────────── */
  useEffect(() => {
    if (hasServiceStep) serviceApi.list().then(setServices).catch(() => { });
  }, [hasServiceStep]);

  /* ── load slots ──────────────────────────────────────────────── */
  useEffect(() => {
    if (step !== 'slot' || !THERAPIST_ID) return;
    const svcId = resolvedSvcId || selectedService?._id;
    const mode = selectedService?.modes?.[0];
    setSlotsLoading(true);
    slotApi.list(THERAPIST_ID, from, to, mode, svcId || undefined)
      .then(setSlots).catch(() => { }).finally(() => setSlotsLoading(false));
  }, [step, resolvedSvcId, selectedService, from, to]);

  /* ── auth guard ──────────────────────────────────────────────── */
  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace('/login?next=/book');
  }, [hydrated, user, router]);

  /* ── check slot on select ────────────────────────────────────── */
  useEffect(() => {
    if (!selectedSlot) return;
    setLoading(true);
    slotApi.checkSlot({
      slotId: selectedSlot._id,
      therapistId: THERAPIST_ID,
      service: resolvedSvcId || selectedService?._id,
      mode: selectedService?.modes?.[0],
    }).then(() => setLoading(false))
      .catch((e: any) => {
        setLoading(false);
        toast(e.message ?? 'Slot no longer available', 'error');
        setSelectedSlot(null);
        setStep('slot');
      });
  }, [selectedSlot]);

  /* ── payment flow: RAZORPAY ──────────────────────────────────── */
  const initiatePayment = async () => {
    if (!selectedSlot) return;
    setLoading(true);
    try {
      const loaded = await loadRazorpay();
      if (!loaded) { toast('Payment gateway failed to load', 'error'); return; }

      const amount = selectedService?.price?.amount ?? 0;
      const { order, txn } = await bookingApi.initiatePayment({
        slotId: selectedSlot._id,
        serviceId: resolvedSvcId || selectedService?._id,
        mode: selectedService?.modes?.[0] || selectedSlot.mode,
        amount,
        intake,
      });

      setPendingTxn({ txnId: txn._id, orderId: order.id, amount });

      const options = {
        key: RZ_KEY,
        amount: order.amount,
        currency: order.currency,
        name: 'Srishti Roy · Therapy',
        description: selectedService?.name ?? 'Therapy Session',
        order_id: order.id,
        prefill: {
          name: user?.name ?? '',
          email: user?.email ?? '',
          contact: user?.phone ?? '',
        },
        theme: { color: '#9b8ec4' },
        handler: async (response: any) => {
          setLoading(true);
          try {
            const result = await bookingApi.verifyPayment({
              slotId: selectedSlot._id,
              txnId: txn._id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            setBooking(result.appt);
            setStep('forms');
          } catch (e: any) {
            toast(e.message ?? 'Payment verification failed', 'error');
          } finally {
            setLoading(false);
          }
        },
        modal: {
          ondismiss: () => {
            setLoading(false);
            toast('Payment cancelled', 'error');
          },
        },
      };

      const rz = new (window as any).Razorpay(options);
      rz.open();
    } catch (e: any) {
      toast(e.message ?? 'Could not initiate payment', 'error');
      setLoading(false);
    }
  };

  /* ── payment flow: STATIC QR + UTR ───────────────────────────── */
  const submitQrPayment = async () => {
    if (!selectedSlot) return;
    if (!utr.trim()) { toast('Enter UTR / transaction reference', 'error'); return; }
    setLoading(true);
    try {
      const amount = selectedService?.price?.amount ?? 0;
      const result = await bookingApi.paymentViaQr({
        slotId: selectedSlot._id,
        serviceId: resolvedSvcId || selectedService?._id,
        mode: selectedService?.modes?.[0] || selectedSlot.mode,
        amount,
        intake,
        utr: utr.trim(),
      });

      setBooking(result.appointment);
      setStep('forms');
    } catch (e: any) {
      toast(e.message ?? 'QR payment verification failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const grouped = groupByDate(slots);
  const days = Object.keys(grouped).sort();
  const amount = selectedService?.price?.amount ?? 0;

  /* ── render ──────────────────────────────────────────────────── */
  return (
    <div style={{
      minHeight: '100vh',
      background: '#f5f0fa',
      backgroundImage: 'radial-gradient(circle at 15% 20%,rgba(155,142,196,0.09) 0%,transparent 55%),radial-gradient(circle at 85% 80%,rgba(122,158,126,0.09) 0%,transparent 55%)',
      paddingTop: 96, paddingBottom: 64, paddingLeft: 16, paddingRight: 16,
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');
        @keyframes spin     { to { transform:rotate(360deg); } }
        @keyframes fadeUp   { from { opacity:0;transform:translateY(12px); } to { opacity:1;transform:translateY(0); } }
        @keyframes pulse-ring { 0%,100%{box-shadow:0 0 0 0 rgba(155,142,196,0.4)} 50%{box-shadow:0 0 0 10px rgba(155,142,196,0)} }
        .step-anim          { animation:fadeUp 0.32s ease both; }
        .slot-btn:hover     { border-color:#9b8ec4 !important; background:rgba(155,142,196,0.07) !important; transform:translateY(-1px); }
        .svc-card:hover     { border-color:rgba(155,142,196,0.5) !important; box-shadow:0 6px 28px rgba(155,142,196,0.14) !important; transform:translateY(-2px); }
        .svc-card, .slot-btn { transition:all 0.18s ease; }
        input[type=text]:focus, textarea:focus { border-color:#9b8ec4 !important; box-shadow:0 0 0 3px rgba(155,142,196,0.12); }
        .dl-btn:hover { background:rgba(155,142,196,0.09) !important; border-color:#9b8ec4 !important; }
        .dl-btn { transition:all 0.18s ease; }
      `}</style>

      <div style={{ maxWidth: 820, margin: '0 auto' }}>

        {/* ── header ────────────────────────────────────────────── */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'linear-gradient(135deg,rgba(155,142,196,0.18),rgba(122,158,126,0.18))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px',
          }}>
            <HeartHandshake size={24} style={{ color: '#9b8ec4' }} />
          </div>
          <p style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#7a9e7e', fontWeight: 600, marginBottom: 8 }}>
            Srishti Roy · Therapist
          </p>
          <h1 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 28, fontWeight: 400, color: '#2d3142', lineHeight: 1.3, margin: '0 0 8px' }}>
            Book a session
          </h1>
          <p style={{ color: '#9ba0ae', fontSize: 14, margin: 0 }}>
            A safe, gentle space — just for you.
          </p>
        </div>

        {step !== 'done' && <ProgressBar step={step} hasServiceStep={hasServiceStep} />}

        {/* ══════════════════════════════════════════════════════════
            STEP: SERVICE
        ══════════════════════════════════════════════════════════ */}
        {step === 'service' && (
          <div className="step-anim">
            <Card>
              <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, fontWeight: 500, color: '#2d3142', marginBottom: 4 }}>
                Choose a service
              </h2>
              <p style={{ fontSize: 13, color: '#9ba0ae', marginBottom: 24 }}>
                Select the type of session that feels right for you.
              </p>

              {services.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <Loader2 size={26} style={{ color: '#9b8ec4', animation: 'spin 1s linear infinite', display: 'inline-block' }} />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {services.map(s => {
                    const active = selectedService?._id === s._id;
                    return (
                      <button key={s._id} className="svc-card"
                        onClick={() => { setSelectedService(s); setStep('slot'); }}
                        style={{
                          textAlign: 'left', width: '100%', cursor: 'pointer',
                          background: active ? 'linear-gradient(135deg,rgba(155,142,196,0.07),rgba(122,158,126,0.07))' : '#fff',
                          border: active ? '2px solid #9b8ec4' : '1.5px solid rgba(155,142,196,0.18)',
                          borderRadius: 16, padding: '18px 20px', fontFamily: 'inherit',
                          boxShadow: active ? '0 4px 18px rgba(155,142,196,0.18)' : 'none',
                        }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <p style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 16, fontWeight: 500, color: '#2d3142', marginBottom: 4, margin: '0 0 4px' }}>
                              {s.name}
                            </p>
                            <p style={{ fontSize: 13, color: '#9ba0ae', marginBottom: 10, lineHeight: 1.5, margin: '0 0 10px' }}>
                              {s.shortDesc}
                            </p>
                            <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#b0b8c4' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Clock size={11} /> {s.durationMin} min
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {s.modes?.includes('online') ? <Monitor size={11} /> : <MapPin size={11} />}
                                {s.modes?.join(' · ')}
                              </span>
                            </div>
                          </div>
                          {s.price?.amount > 0 && (
                            <span style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, color: '#6b5ea8', flexShrink: 0, fontWeight: 500 }}>
                              ₹{s.price.amount.toLocaleString('en-IN')}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP: SLOT
        ══════════════════════════════════════════════════════════ */}
        {step === 'slot' && (
          <div className="step-anim">
            {hasServiceStep && <Back onClick={() => setStep('service')} />}
            <Card>
              <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, fontWeight: 500, color: '#2d3142', marginBottom: 4 }}>
                Choose a date & time
              </h2>
              <p style={{ fontSize: 13, color: '#9ba0ae', marginBottom: 24 }}>
                Times shown in your local timezone · Next 14 days
              </p>

              {slotsLoading ? (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <Loader2 size={28} style={{ color: '#9b8ec4', animation: 'spin 1s linear infinite', display: 'inline-block' }} />
                  <p style={{ color: '#9ba0ae', fontSize: 13, marginTop: 10 }}>Finding open slots…</p>
                </div>
              ) : days.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ba0ae' }}>
                  <Waves size={28} style={{ margin: '0 auto 12px', color: '#7b96b2', display: 'block' }} />
                  <p style={{ fontSize: 14 }}>No available slots in the next 14 days.<br />Please reach out directly.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
                  {days.map(day => (
                    <div key={day}>
                      <p style={{ fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#7a9e7e', fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Calendar size={12} /> {formatDate(day)}
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
                        {grouped[day].map(slot => {
                          const active = selectedSlot?._id === slot._id;
                          return (
                            <button key={slot._id} className="slot-btn"
                              onClick={() => { setSelectedSlot(slot); setStep('intake'); }}
                              style={{
                                padding: '9px 17px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                                border: active ? '2px solid #9b8ec4' : '1.5px solid rgba(155,142,196,0.22)',
                                background: active ? 'linear-gradient(135deg,#ede8f8,#e4ecf4)' : '#fff',
                                color: active ? '#6b5ea8' : '#5a6070',
                                cursor: 'pointer', fontFamily: 'inherit',
                                boxShadow: active ? '0 2px 12px rgba(155,142,196,0.2)' : 'none',
                              }}>
                              <Clock size={11} style={{ verticalAlign: 'middle', marginRight: 5, opacity: 0.6 }} />
                              {formatTime(slot.startAt)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP: INTAKE
        ══════════════════════════════════════════════════════════ */}
        {step === 'intake' && (
          <div className="step-anim">
            <Back onClick={() => setStep('slot')} />
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(122,158,126,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <BookOpen size={17} style={{ color: '#7a9e7e' }} />
                </div>
                <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, fontWeight: 500, color: '#2d3142', margin: 0 }}>
                  A little about you
                </h2>
              </div>
              <p style={{ fontSize: 13, color: '#9ba0ae', marginBottom: 26, marginLeft: 48 }}>
                All information is strictly confidential.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#7a9e7e', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                    What brings you here?
                  </label>
                  <textarea rows={4} value={intake.primaryConcern}
                    onChange={e => setIntake(p => ({ ...p, primaryConcern: e.target.value }))}
                    placeholder="Share as much or as little as you'd like…"
                    style={fieldStyle} />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '14px 16px', borderRadius: 12, border: '1.5px solid rgba(155,142,196,0.18)', background: intake.prevTherapy ? 'rgba(155,142,196,0.06)' : '#fff', transition: 'background 0.2s' }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: 6, border: '2px solid',
                    borderColor: intake.prevTherapy ? '#9b8ec4' : 'rgba(155,142,196,0.35)',
                    background: intake.prevTherapy ? '#9b8ec4' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    transition: 'all 0.2s',
                  }}>
                    {intake.prevTherapy && <Check size={12} color="#fff" />}
                  </div>
                  <input type="checkbox" checked={intake.prevTherapy}
                    onChange={e => setIntake(p => ({ ...p, prevTherapy: e.target.checked }))}
                    style={{ display: 'none' }} />
                  <span style={{ fontSize: 14, color: '#5a6070' }}>I have been in therapy before</span>
                </label>

                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#7a9e7e', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                    Anything else? <span style={{ color: '#b0b8c4', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
                  </label>
                  <textarea rows={3} value={intake.notes}
                    onChange={e => setIntake(p => ({ ...p, notes: e.target.value }))}
                    placeholder="E.g. preferred language, accessibility needs…"
                    style={fieldStyle} />
                </div>
              </div>

              <div style={{ marginTop: 28 }}>
                <PrimaryBtn onClick={() => setStep('payment')}>
                  Continue to payment <ChevronRight size={16} />
                </PrimaryBtn>
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP: PAYMENT
        ══════════════════════════════════════════════════════════ */}
        {step === 'payment' && selectedSlot && (
          <div className="step-anim">
            <Back onClick={() => setStep('intake')} />
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(155,142,196,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <CreditCard size={17} style={{ color: '#9b8ec4' }} />
                </div>
                <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, fontWeight: 500, color: '#2d3142', margin: 0 }}>
                  Review & pay
                </h2>
              </div>

              {/* summary rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 24 }}>
                {[
                  { label: 'Therapist', value: 'Srishti Roy' },
                  ...(selectedService ? [{ label: 'Service', value: selectedService.name }] : []),
                  { label: 'Date', value: formatDate(selectedSlot.startAt) },
                  { label: 'Time', value: `${formatTime(selectedSlot.startAt)} · ${selectedSlot.durationMin ?? 60} min` },
                  { label: 'Mode', value: (selectedSlot.mode ?? '').replace('_', ' ') },
                ].map((row, i, arr) => (
                  <div key={row.label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '12px 0',
                    borderBottom: i < arr.length - 1 ? '1px solid rgba(155,142,196,0.1)' : 'none',
                  }}>
                    <span style={{ fontSize: 13, color: '#9ba0ae' }}>{row.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: '#2d3142', textTransform: 'capitalize' }}>{row.value}</span>
                  </div>
                ))}

                {amount > 0 && (
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '16px 0 4px',
                    borderTop: '2px solid rgba(155,142,196,0.12)', marginTop: 4,
                  }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#2d3142' }}>Total</span>
                    <span style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 24, color: '#6b5ea8', fontWeight: 500 }}>
                      ₹{amount.toLocaleString('en-IN')}
                    </span>
                  </div>
                )}
              </div>

              {/* trust badge */}
              <div style={{
                padding: '12px 16px', borderRadius: 12, marginBottom: 22,
                background: 'rgba(122,158,126,0.06)',
                border: '1px solid rgba(122,158,126,0.18)',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <ShieldCheck size={16} style={{ color: '#7a9e7e', flexShrink: 0 }} />
                <p style={{ fontSize: 12, color: '#7a9e7e', margin: 0, lineHeight: 1.5 }}>
                  {PAYMENT_MODE === 'rzp'
                    ? 'Payments are secured by Razorpay. Your slot is held for 10 minutes while you complete payment.'
                    : 'Your slot is held for 10 minutes while you complete payment. Scan the QR, then enter your UPI transaction reference.'}
                </p>
              </div>

              {/* cancellation note */}
              <div style={{
                padding: '12px 16px', borderRadius: 12, marginBottom: 24,
                background: 'rgba(155,142,196,0.05)',
                border: '1px solid rgba(155,142,196,0.14)',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <AlertCircle size={15} style={{ color: '#9b8ec4', flexShrink: 0, marginTop: 1 }} />
                <p style={{ fontSize: 12, color: '#9ba0ae', margin: 0, lineHeight: 1.6 }}>
                  <strong style={{ color: '#6b5ea8' }}>Cancellation policy:</strong> Free cancellation 24+ hours before your session. No refund within 24 hours. Rescheduling allowed up to 10 hours before.
                </p>
              </div>

              {/* ── PAY: mode decided in code (PAYMENT_MODE) ── */}
              {PAYMENT_MODE === 'rzp' ? (
                <PrimaryBtn onClick={initiatePayment} loading={loading}>
                  <CreditCard size={16} /> Pay ₹{amount.toLocaleString('en-IN')} securely
                </PrimaryBtn>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {/* QR image */}
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
                    padding: '22px', borderRadius: 16,
                    background: 'rgba(155,142,196,0.05)', border: '1.5px solid rgba(155,142,196,0.16)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b5ea8', fontSize: 13, fontWeight: 600 }}>
                      <QrCode size={16} /> Scan &amp; Pay via UPI
                    </div>
                    <img src={STATIC_QR_URL} alt="Payment QR"
                      style={{ width: 220, height: 220, objectFit: 'contain', borderRadius: 12, background: '#fff', padding: 8 }} />
                    <p style={{ fontSize: 13, color: '#5a6070', textAlign: 'center', margin: 0, lineHeight: 1.6 }}>
                      Pay <strong style={{ color: '#6b5ea8' }}>₹{amount.toLocaleString('en-IN')}</strong> with any UPI app
                      {UPI_ID && <><br /><span style={{ fontSize: 12, color: '#9ba0ae' }}>UPI ID: <strong style={{ color: '#6b5ea8' }}>{UPI_ID}</strong></span></>}
                    </p>
                  </div>

                  {/* UTR input */}
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#7a9e7e', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                      UTR / Transaction reference
                    </label>
                    <input type="text" value={utr}
                      onChange={e => setUtr(e.target.value)}
                      placeholder="e.g. 4051XXXXXXXX"
                      style={fieldStyle} />
                    <p style={{ fontSize: 12, color: '#9ba0ae', margin: '8px 2px 0', lineHeight: 1.5 }}>
                      After paying, find the 12-digit UTR / reference number in your UPI app and paste it here.
                    </p>
                  </div>

                  <PrimaryBtn onClick={submitQrPayment} loading={loading} disabled={!utr.trim()}>
                    <ShieldCheck size={16} /> Confirm payment
                  </PrimaryBtn>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP: FORMS (post-payment)
        ══════════════════════════════════════════════════════════ */}
        {step === 'forms' && booking && (
          <div className="step-anim">
            <Card>
              {/* confirmed badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28, padding: '16px 18px', borderRadius: 14, background: 'linear-gradient(135deg,rgba(122,158,126,0.09),rgba(155,142,196,0.09))', border: '1px solid rgba(122,158,126,0.2)' }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg,#7a9e7e,#9b8ec4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Check size={20} color="#fff" />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 600, color: '#2d3142', margin: '0 0 2px' }}>
                    Payment confirmed!
                  </p>
                  <p style={{ fontSize: 12, color: '#9ba0ae', margin: 0 }}>
                    Booking code: <strong style={{ color: '#6b5ea8' }}>{booking.bookingCode}</strong>
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(123,150,178,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <FileText size={17} style={{ color: '#7b96b2' }} />
                </div>
                <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 20, fontWeight: 500, color: '#2d3142', margin: 0 }}>
                  One last step
                </h2>
              </div>
              <p style={{ fontSize: 14, color: '#5a6070', marginBottom: 28, marginLeft: 48, lineHeight: 1.6 }}>
                Please download, fill in, and upload both forms before your session. This helps Srishti prepare and ensures everything is in order.
              </p>

              {/* download cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 28 }}>
                {[
                  {
                    title: 'Intake Form',
                    desc: 'Background information about you and your reasons for seeking therapy.',
                    url: INTAKE_FORM_URL,
                    icon: <BookOpen size={18} style={{ color: '#9b8ec4' }} />,
                    color: 'rgba(155,142,196,0.08)',
                    border: 'rgba(155,142,196,0.22)',
                  },
                  {
                    title: 'Consent Form',
                    desc: 'Informed consent covering confidentiality, session policies, and your rights.',
                    url: CONSENT_FORM_URL,
                    icon: <ShieldCheck size={18} style={{ color: '#7a9e7e' }} />,
                    color: 'rgba(122,158,126,0.07)',
                    border: 'rgba(122,158,126,0.22)',
                  },
                ].map(f => (
                  <div key={f.title} style={{ padding: '18px 20px', borderRadius: 14, background: f.color, border: `1.5px solid ${f.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                          {f.icon}
                        </div>
                        <div>
                          <p style={{ fontWeight: 600, color: '#2d3142', margin: '0 0 3px', fontSize: 14 }}>{f.title}</p>
                          <p style={{ fontSize: 12, color: '#9ba0ae', margin: 0, lineHeight: 1.5 }}>{f.desc}</p>
                        </div>
                      </div>
                      <a href={f.url} download className="dl-btn" style={{
                        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                        padding: '8px 14px', borderRadius: 10,
                        border: '1.5px solid rgba(155,142,196,0.25)',
                        background: '#fff', color: '#6b5ea8',
                        textDecoration: 'none', fontSize: 13, fontWeight: 500,
                        fontFamily: 'inherit',
                      }}>
                        <Download size={13} /> Download
                      </a>
                    </div>
                  </div>
                ))}
              </div>

              {/* upload instruction */}
              <div style={{
                padding: '16px 18px', borderRadius: 14,
                background: 'rgba(123,150,178,0.06)',
                border: '1.5px dashed rgba(123,150,178,0.35)',
                display: 'flex', gap: 12, alignItems: 'flex-start',
                marginBottom: 28,
              }}>
                <Upload size={18} style={{ color: '#7b96b2', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p style={{ fontWeight: 600, color: '#2d3142', margin: '0 0 4px', fontSize: 14 }}>
                    Upload completed forms via your dashboard
                  </p>
                  <p style={{ fontSize: 13, color: '#9ba0ae', margin: '0 0 12px', lineHeight: 1.5 }}>
                    Once filled and signed, go to <strong style={{ color: '#6b5ea8' }}>My Appointments → {booking.bookingCode}</strong> and upload both PDFs under the <em>Documents</em> tab. Forms must be uploaded at least 24 hours before your session.
                  </p>
                  <Link href={`/dashboard/appointments/${booking._id}`} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 18px', borderRadius: 10,
                    background: 'linear-gradient(135deg,#9b8ec4,#7b96b2)',
                    color: '#fff', textDecoration: 'none', fontSize: 13, fontWeight: 500,
                    fontFamily: 'inherit', boxShadow: '0 3px 12px rgba(155,142,196,0.28)',
                  }}>
                    <Upload size={13} /> Go to my appointment
                  </Link>
                </div>
              </div>

              {/* done */}
              <PrimaryBtn onClick={() => setStep('done')}>
                All done <Sparkles size={15} />
              </PrimaryBtn>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP: DONE
        ══════════════════════════════════════════════════════════ */}
        {step === 'done' && booking && (
          <div className="step-anim">
            <Card style={{ textAlign: 'center', padding: '52px 32px' }}>
              <div style={{
                width: 68, height: 68, borderRadius: '50%',
                background: 'linear-gradient(135deg,#7a9e7e,#9b8ec4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 20px',
                boxShadow: '0 8px 32px rgba(122,158,126,0.25)',
                animation: 'pulse-ring 2.5s ease-in-out infinite',
              }}>
                <Check size={30} color="#fff" />
              </div>

              <h2 style={{ fontFamily: "'Lora',Georgia,serif", fontSize: 28, fontWeight: 400, color: '#2d3142', marginBottom: 8 }}>
                You're all set 🌿
              </h2>
              <p style={{ color: '#9ba0ae', fontSize: 14, marginBottom: 4 }}>
                Booking code: <strong style={{ color: '#6b5ea8' }}>{booking.bookingCode}</strong>
              </p>
              <p style={{ color: '#b0b8c4', fontSize: 13, marginBottom: 32 }}>
                A confirmation email is on its way to your inbox.
              </p>

              <div style={{
                padding: '16px 20px', borderRadius: 14, marginBottom: 28,
                background: 'linear-gradient(135deg,rgba(155,142,196,0.07),rgba(122,158,126,0.07))',
                border: '1px solid rgba(155,142,196,0.12)',
              }}>
                <p style={{ fontSize: 13, color: '#7a9e7e', lineHeight: 1.6, margin: 0, fontStyle: 'italic' }}>
                  "Take a gentle breath. You've taken a meaningful step today."
                </p>
              </div>

              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link href="/dashboard" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '11px 22px', borderRadius: 12,
                  background: 'linear-gradient(135deg,#9b8ec4,#7b96b2)',
                  color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 500,
                  fontFamily: 'inherit', boxShadow: '0 4px 16px rgba(155,142,196,0.3)',
                }}>
                  <Calendar size={14} /> My appointments
                </Link>
                <Link href="/" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '11px 22px', borderRadius: 12,
                  border: '1.5px solid rgba(155,142,196,0.3)',
                  color: '#6b5ea8', textDecoration: 'none', fontSize: 14, fontWeight: 500,
                  fontFamily: 'inherit', background: '#fff',
                }}>
                  <Home size={14} /> Return home
                </Link>
              </div>
            </Card>
          </div>
        )}

      </div>
    </div>
  );
}

/* ─── Page Wrapper ───────────────────────────────────────────────── */
export default function BookPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f0fa' }}>
        <Loader2 size={28} style={{ color: '#9b8ec4', animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    }>
      <BookingContent />
    </Suspense>
  );
}