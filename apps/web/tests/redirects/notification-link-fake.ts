// An in-memory Prisma for the notification sign-in link routes (`/r/re`,
// `/r/ml`). It reads exactly the `where` shapes lib/auth/notification-link*.ts
// sends, and ignores any key it was not written for — so a filter the code
// stops sending shows up as a test that lets too much through.

type Verification = { id: string; identifier: string; value: string; expiresAt: Date };
type Student = { id: string; email: string | null; disabledAt: Date | null };
type Booking = { id: string; studentId: string; packageId: string };
type Notification = {
  id: string;
  teacherId: string;
  recipientId: string;
  recipientType: "student" | "teacher";
  templateName: string;
};
type Pairing = { teacherId: string; studentId: string };

export const db = {
  verification: [] as Verification[],
  students: [] as Student[],
  bookings: [] as Booking[],
  notifications: [] as Notification[],
  pairings: [] as Pairing[],
  adminEmails: [] as string[],
  teachers: [] as Array<{ id: string; email: string }>,
  users: [] as Array<{ id: string; email: string }>,
};

export function resetDb() {
  db.verification = [];
  db.students = [{ id: "s-1", email: "alumna@example.com", disabledAt: null }];
  db.bookings = [{ id: "booking-1", studentId: "s-1", packageId: "pkg-1" }];
  db.notifications = [
    {
      id: "notif-1",
      teacherId: "t-1",
      recipientId: "s-1",
      recipientType: "student",
      templateName: "magic_link",
    },
  ];
  db.pairings = [{ teacherId: "t-1", studentId: "s-1" }];
  db.adminEmails = [];
  db.teachers = [{ id: "t-1", email: "profe@example.com" }];
  db.users = [];
}

const same = (a: string | null | undefined, b: { equals: string } | string | undefined) =>
  typeof b === "object"
    ? (a ?? "").toLowerCase() === b.equals.toLowerCase()
    : b === undefined || a === b;

let nextId = 0;

export const fakePrisma = {
  verification: {
    create: async ({ data }: { data: Omit<Verification, "id"> }) => {
      const row = { id: `v-${++nextId}`, ...data };
      db.verification.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: { identifier: string } }) =>
      db.verification.find((r) => r.identifier === where.identifier) ?? null,
    deleteMany: async ({ where }: { where: { id: string } }) => {
      const before = db.verification.length;
      db.verification = db.verification.filter((r) => r.id !== where.id);
      return { count: before - db.verification.length };
    },
  },
  student: {
    findFirst: async ({ where }: { where: { id: string } }) =>
      db.students.find((s) => s.id === where.id) ?? null,
  },
  booking: {
    findFirst: async ({ where }: { where: { id: string; studentId: string } }) => {
      const b = db.bookings.find((x) => x.id === where.id && x.studentId === where.studentId);
      return b ? { packageId: b.packageId } : null;
    },
  },
  notification: {
    findFirst: async ({ where }: { where: Partial<Notification> }) => {
      const n = db.notifications.find(
        (x) =>
          x.id === where.id &&
          x.templateName === where.templateName &&
          x.recipientType === where.recipientType &&
          x.recipientId === where.recipientId,
      );
      return n ? { teacherId: n.teacherId } : null;
    },
  },
  teacherStudent: {
    findFirst: async ({ where }: { where: Pairing }) =>
      db.pairings.find((p) => p.teacherId === where.teacherId && p.studentId === where.studentId) ??
      null,
  },
  adminUser: {
    findFirst: async ({ where }: { where: { email: { equals: string } } }) => {
      const email = db.adminEmails.find((e) => same(e, where.email));
      return email ? { id: "admin-1" } : null;
    },
  },
  user: {
    findMany: async ({ where }: { where: { email: { equals: string } } }) =>
      db.users.filter((u) => same(u.email, where.email)).map((u) => ({ id: u.id })),
  },
  teacher: {
    findFirst: async ({
      where,
    }: {
      where: { OR: [{ email: { equals: string } }, { id: { in: string[] } }] };
    }) => {
      const [byEmail, byId] = where.OR;
      const t = db.teachers.find((x) => same(x.email, byEmail.email) || byId.id.in.includes(x.id));
      return t ? { id: t.id } : null;
    },
  },
};
