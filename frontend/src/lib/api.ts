const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api/v1';

let refreshing: Promise<string | null> | null = null;

function getAccess() {
  if (typeof window === 'undefined') return null;
  const auth = localStorage.getItem('auth');
  if (!auth) return null;
  try {
    const parsed = JSON.parse(auth);
    return parsed?.state?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getRefresh() {
  if (typeof window === 'undefined') return null;
  try {
    const auth = localStorage.getItem('auth');
    if (!auth) return null;
    const parsed = JSON.parse(auth);
    return parsed?.state?.refreshToken ?? null;
  } catch {
    return null;
  }
}

async function doRefresh(): Promise<string | null> {
  const refreshToken = getRefresh();
  if (!refreshToken) return null;
  try {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      localStorage.removeItem('auth');
      return null;
    }
    const { data } = await response.json();
    const auth = localStorage.getItem('auth');
    if (auth) {
      const parsed = JSON.parse(auth);
      parsed.state.accessToken = data.accessToken;
      parsed.state.refreshToken = data.refreshToken;
      localStorage.setItem('auth', JSON.stringify(parsed));
    }
    return data.accessToken;
  } catch (error) {
    console.error('Refresh failed', error);
    localStorage.removeItem('auth');
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = getAccess();

  const make = async (t: string | null) => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          'Content-Type': 'application/json',
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
      return response;
    } catch (error) {
      console.error('❌ Network error:', error);
      throw new ApiClientError(500, 'Network error. Please check internet connection.');
    }
  };

  let res = await make(token);

  if ((res.status === 401 || res.status === 403) && token) {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    token = await refreshing;
    if (!token) throw new ApiClientError(401, 'Session expired');
    res = await make(token);
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch (error) {
    json = { success: false, message: res.statusText || 'Invalid server response' };
  }

  if (!res.ok) {
    throw new ApiClientError(res.status, json?.message || 'Something went wrong', json?.details);
  }

  // request() already unwraps the envelope — callers get T directly, not ApiResponse<T>
  return json.data as T;
}

export class ApiClientError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

// api methods type as T directly — request() handles the envelope unwrapping
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// Typed API methods
export const authApi = {
  register: (d: unknown) => api.post('/auth/register', d),
  login: (d: unknown) => api.post<{ user: User; accessToken: string; refreshToken: string }>('/auth/login', d),
  google: (idToken: string) => api.post<{ user: User; accessToken: string; refreshToken: string }>('/auth/google', { idToken }),
  logout: (refreshToken: string) => api.post('/auth/logout', { refreshToken }),
  forgotPassword: (email: string) => api.post('/auth/forgot', { email }),
  resetPassword: (d: unknown) => api.post('/auth/reset', d),
  me: () => api.get<User>('/auth/me'),
};

export const therapistApi = {
  list: (params?: Record<string, string>) => api.get<Therapist[]>(`/therapists?${new URLSearchParams(params)}`),
  bySlug: (slug: string) => api.get<Therapist>(`/therapists/${slug}`),
};

export const serviceApi = {
  list: () => api.get<Service[]>('/services'),
  bySlug: (slug: string) => api.get<Service>(`/services/${slug}`),
};

export const slotApi = {
  list: (therapistId: string, from: string, to: string, mode?: string, service?: string) => {
    const url =
      `/bookings/slots?therapistId=${therapistId}&from=${from}&to=${to}` +
      `${mode ? `&mode=${mode}` : ''}` +
      `${service ? `&service=${service}` : ''}`;
    return api.get<Slot[]>(url);
  },
  checkSlot: (d: unknown) => api.post<Slot>('/bookings/check-slot', d),
  hold: (slotId: string) => api.post(`/bookings/slots/${slotId}/hold`),
  release: (slotId: string) => api.delete(`/bookings/slots/${slotId}/hold`),
};

export const bookingApi = {
  book: (d: unknown) => api.post<Appointment>('/bookings', d),
  myAppointments: () => api.get<Appointment[]>('/bookings/me'),
  SinglemyAppointments: (id: string) => api.get<Appointment[]>(`/bookings/me/${id}`),

  cancel: (id: string, reason?: string) => api.patch(`/bookings/${id}/cancel`, { reason }),
  reschedule: (id: string, newSlotId: string) => api.patch(`/bookings/${id}/reschedule`, { newSlotId }),
  initiatePayment: (d: unknown) => api.post<{ appointment: Appointment; txn: any; order: any }>('/bookings/initiate-payment', d),
  paymentViaQr: (d: unknown) => api.post<{ appointment: Appointment; txn: any; order: any }>('/bookings/initiate-payment', d),


  upload: (d: unknown) => api.post<{ appointment: Appointment; txn: any; order: any }>('/bookings/initiate-payment', d),

  verifyPayment: (d: unknown) => api.post<{ appt: Appointment; txn: any }>('/bookings/verify-payment', d),
};

export const blogApi = {
  list: (page = 1, tag?: string) => api.get<{ items: Blog[]; total: number }>(`/blogs?page=${page}${tag ? `&tag=${tag}` : ''}`),
  bySlug: (slug: string) => api.get<Blog>(`/blogs/${slug}`),
};

export const publicApi = {
  testimonials: () => api.get<Testimonial[]>('/testimonials'),
  faqs: () => api.get<Faq[]>('/faqs'),
  contact: (d: unknown) => api.post('/contact', d),
  seo: (page: string) => api.get<SeoMeta>(`/seo/${page}`),
  brandSettings: () => api.get<Record<string, any>>('/settings/public'),
};

// Types
export type User = { _id: string; name: string; email: string; phone: string; role: string; avatar?: { url: string }; isEmailVerified: boolean };
export type Therapist = { _id: string; slug: string; title: string; bio: string; shortBio: string; specializations: string[]; languages: string[]; consultationFee: { amount: number; currency: string }; defaultSlotDurationMin: number; user: { name: string; avatar?: { url: string } }; rating: { avg: number; count: number } };
export type Service = { _id: string; slug: string; name: string; shortDesc: string; description: string; durationMin: number; price: { amount: number; currency: string }; modes: string[]; category: string };
export type Slot = { _id: string; startAt: string; endAt: string; durationMin: number; mode: string; status: string };
export type Appointment = { _id: string; bookingCode: string; startAt: string; endAt: string; status: string; mode: string; therapist: Partial<Therapist>; service?: Partial<Service> };
export type Blog = { _id: string; slug: string; title: string; excerpt: string; coverImage?: { url: string; alt: string }; publishedAt: string; tags: string[]; readingTimeMin?: number };
export type Testimonial = { _id: string; authorName: string; rating: number; text: string };
export type Faq = { _id: string; question: string; answer: string; category: string; order: number };
export type SeoMeta = { title: string; description: string; keywords: string[]; ogImage?: string; jsonLd?: Record<string, unknown> };