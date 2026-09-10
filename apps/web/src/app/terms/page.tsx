import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_EMAIL } from "@/lib/support";
import { Logo } from "@/components/brand/logo";
import { hasStripeCreds } from "@/lib/env";
import { createT } from "@/lib/i18n-translate";

const CONTACT_EMAIL = SUPPORT_EMAIL;

// Metadata follows the ?lang param (which picks the rendered variant), not the
// locale cookie. The canonical points both variants at the bare URL so
// /terms?lang=en never competes with /terms in the index.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}): Promise<Metadata> {
  const { lang } = await searchParams;
  const t = createT(lang === "en" ? "en" : "es-MX");
  return {
    title: t("web.terms.meta.title"),
    description: t("web.terms.meta.description"),
    alternates: { canonical: "/terms" },
  };
}

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  const isEnglish = lang === "en";
  const stripeAvailable = hasStripeCreds();
  return (
    <main className="container space-y-6 py-10 text-sm leading-relaxed lg:max-w-2xl">
      <Link href="/" aria-label="SpiralClass" className="inline-block">
        <Logo size="sm" />
      </Link>
      {isEnglish ? (
        <EnglishTerms stripeAvailable={stripeAvailable} />
      ) : (
        <SpanishTerms stripeAvailable={stripeAvailable} />
      )}
    </main>
  );
}

function SpanishTerms({ stripeAvailable }: { stripeAvailable: boolean }) {
  return (
    <article lang="es-MX" className="space-y-4">
      <header>
        <Heading level={2} as="h1">
          Términos y condiciones
        </Heading>
        <p className="text-xs text-muted-foreground">
          Última actualización: 10 de julio de 2026 ·{" "}
          <Link className="underline" href="/terms?lang=en">
            English
          </Link>
        </p>
      </header>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          1. Identidad
        </Heading>
        <p>
          SpiralClass (en adelante, &ldquo;la Plataforma&rdquo;) provee herramientas de
          agendamiento, cobro y comunicación a maestras independientes (&ldquo;Maestras&rdquo;) y
          sus estudiantes (&ldquo;Estudiantes&rdquo;). La Plataforma no es proveedora de servicios
          educativos: el contrato de clases es directamente entre la Maestra y la Estudiante.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          2. Aceptación
        </Heading>
        <p>
          Al crear una cuenta, comprar un paquete de clases o usar cualquier función de la
          Plataforma, aceptas estos Términos. Si no estás de acuerdo, no uses el servicio.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          3. Cuentas y elegibilidad
        </Heading>
        <p>
          Debes tener al menos 18 años para registrarte como Maestra. Las Estudiantes menores de
          edad pueden usar el servicio bajo la supervisión de un padre, madre o tutor legal. La
          Plataforma puede rechazar o suspender una cuenta en cualquier momento, sin previo aviso,
          cuando exista sospecha razonable de fraude, abuso o incumplimiento de estos Términos.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          4. Pagos
        </Heading>
        <p>
          Los pagos se procesan a través de proveedores externos (
          {stripeAvailable ? "Stripe y " : ""}Wise). La Plataforma actúa como facilitadora: el
          dinero se transfiere a la cuenta de la Maestra, descontando comisiones del proveedor de
          pagos. La Plataforma no almacena información de tarjetas ni de cuentas bancarias.
        </p>
        <p>
          Los paquetes de clases se cobran por adelantado. La cantidad de clases, su duración y el
          precio se muestran antes del pago.
        </p>
        <p>
          Las Maestras pueden además suscribirse a un plan de pago recurrente (mensual o anual) para
          desbloquear funciones adicionales de la Plataforma. Estas suscripciones se renuevan
          automáticamente al final de cada periodo salvo que se cancelen antes de la fecha de
          renovación; la cancelación aplica a partir del siguiente periodo y no genera reembolso del
          periodo ya iniciado. Toda nueva Maestra recibe un periodo de prueba sin costo; al
          finalizar, la cuenta pasa automáticamente al plan gratuito si no se activa un plan de
          pago.
        </p>
      </section>

      {/* id shared with the English render: deduction emails deep-link to
          /terms#cancelaciones regardless of language. */}
      <section id="cancelaciones" className="space-y-2">
        <Heading level={4} as="h2">
          5. Cancelaciones y reembolsos
        </Heading>
        <p>
          Las cancelaciones siguen la regla de 24 horas: una clase cancelada con menos de 24 horas
          de anticipación se descuenta del paquete y no es reembolsable. Una clase cancelada con
          anticipación de 24 horas o más libera la clase de vuelta al paquete y puede reagendarse,
          sujeto a la disponibilidad de la Maestra.
        </p>
        <p>
          Este beneficio de cancelación/reagendamiento con anticipación está limitado a un cambio
          por cada clase del paquete (la misma bolsa que usa un reagendamiento directo). Una vez
          agotada esa bolsa, incluso una cancelación con 24 horas o más de anticipación deja de
          liberar la clase; la Estudiante puede optar por dejarla correr o pedirle a la Maestra que
          la libere manualmente.
        </p>
        <p>
          Reembolsos: una clase no impartida (cancelada por la Maestra y no reagendada) puede
          reembolsarse a discreción de la Maestra. La Plataforma facilita el reembolso a través del
          proveedor de pagos original; las comisiones del proveedor no se reembolsan.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          6. Uso aceptable
        </Heading>
        <p>
          No está permitido: (a) usar la Plataforma para fines ilegales o fraudulentos; (b) acosar,
          amenazar o discriminar a otras personas; (c) intentar acceder a cuentas ajenas o vulnerar
          la seguridad del servicio; (d) automatizar el uso de la Plataforma sin autorización
          escrita; (e) revender o ceder tu cuenta.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          7. Suspensión y terminación
        </Heading>
        <p>
          Puedes cerrar tu cuenta en cualquier momento contactando a{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . La Plataforma puede suspender o cerrar una cuenta por incumplimiento de estos Términos.
          Las clases pagadas y aún no impartidas se procesan según la Sección 5.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          8. Propiedad intelectual
        </Heading>
        <p>
          Los materiales que cada Maestra sube a la Plataforma (planes de clase, ejercicios, audio,
          video) son propiedad de la Maestra. La Plataforma recibe una licencia limitada y no
          exclusiva para almacenar y entregar esos materiales a las Estudiantes de la Maestra. La
          marca SpiralClass, su sitio y su código son propiedad de la Plataforma.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          9. Limitación de responsabilidad
        </Heading>
        <p>
          La Plataforma se ofrece &ldquo;tal como está&rdquo;. En la máxima medida permitida por la
          ley, la Plataforma no es responsable por daños indirectos, lucro cesante o pérdida de
          datos. La responsabilidad total de la Plataforma frente a cualquier reclamo no excederá el
          monto pagado a la Plataforma por la usuaria en los 12 meses anteriores al reclamo.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          10. Ley aplicable
        </Heading>
        <p>
          Estos Términos se rigen por las leyes de Inglaterra y Gales. Las controversias se
          resolverán ante los tribunales de Inglaterra y Gales, renunciando las partes a cualquier
          otro fuero que pudiera corresponderles. Esto no elimina las protecciones que la ley del
          país de residencia de una Estudiante le otorgue de forma obligatoria como consumidora.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          11. Cambios a estos Términos
        </Heading>
        <p>
          Podemos actualizar estos Términos cuando sea necesario. Los cambios significativos se
          anunciarán por correo a las usuarias activas con al menos 15 días de anticipación. El uso
          continuado después de la fecha de entrada en vigor constituye aceptación de la versión
          actualizada.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          12. Videollamadas y subtítulos en vivo
        </Heading>
        <p>
          Las clases se imparten por videollamada. Si tú o tu maestra activan los subtítulos en
          vivo, el audio de quien habla se envía en tiempo real a un proveedor externo de
          reconocimiento de voz y a un proveedor externo de traducción con inteligencia artificial,
          únicamente para generar el texto traducido en pantalla; ese audio no se almacena ni se usa
          para ningún otro fin. Subtitular tu propia voz requiere tu consentimiento explícito,
          otorgable o revocable en cualquier momento desde la configuración de tu cuenta — consulta
          nuestro{" "}
          <Link className="underline" href="/privacy-notice">
            aviso de privacidad
          </Link>{" "}
          para más detalle.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          13. Contacto
        </Heading>
        <p>
          ¿Dudas? Escribe a{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . Consulta también nuestro{" "}
          <Link className="underline" href="/privacy-notice">
            aviso de privacidad
          </Link>
          .
        </p>
      </section>
    </article>
  );
}

function EnglishTerms({ stripeAvailable }: { stripeAvailable: boolean }) {
  return (
    <article lang="en" className="space-y-4">
      <header>
        <Heading level={2} as="h1">
          Terms of Service
        </Heading>
        <p className="text-xs text-muted-foreground">
          Last updated: July 10, 2026 ·{" "}
          <Link className="underline" href="/terms">
            Español
          </Link>
        </p>
      </header>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          1. Identity
        </Heading>
        <p>
          SpiralClass (the &ldquo;Platform&rdquo;) provides scheduling, payment, and communication
          tools to independent teachers (&ldquo;Teachers&rdquo;) and their students
          (&ldquo;Students&rdquo;). The Platform is not an education provider: the class agreement
          is directly between the Teacher and the Student.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          2. Acceptance
        </Heading>
        <p>
          By creating an account, purchasing a class package, or using any feature of the Platform,
          you accept these Terms. If you don&apos;t agree, don&apos;t use the service.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          3. Accounts and eligibility
        </Heading>
        <p>
          You must be at least 18 years old to sign up as a Teacher. Students under 18 may use the
          service under the supervision of a parent or legal guardian. The Platform may decline or
          suspend an account at any time, without prior notice, where there is reasonable suspicion
          of fraud, abuse, or breach of these Terms.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          4. Payments
        </Heading>
        <p>
          Payments are processed through external providers ({stripeAvailable ? "Stripe and " : ""}
          Wise). The Platform is a facilitator: funds are transferred to the Teacher&apos;s account
          net of provider fees. The Platform does not store card or bank-account information.
        </p>
        <p>
          Class packages are charged in advance. The number of classes, their duration, and the
          price are shown before payment.
        </p>
        <p>
          Teachers may additionally subscribe to a recurring paid plan (monthly or annual) to unlock
          additional Platform features. These subscriptions renew automatically at the end of each
          billing period unless canceled before the renewal date; cancellation takes effect at the
          end of the current period and does not refund the period already in progress. Every new
          Teacher gets a free trial period; at its end the account automatically falls to the free
          plan unless a paid plan is active.
        </p>
      </section>

      <section id="cancelaciones" className="space-y-2">
        <Heading level={4} as="h2">
          5. Cancellations and refunds
        </Heading>
        <p>
          Cancellations follow the 24-hour rule: a class canceled less than 24 hours before its
          scheduled time is deducted from the package and is not refundable. A class canceled with
          24+ hours&apos; notice releases the class back to the package and may be rescheduled,
          subject to the Teacher&apos;s availability.
        </p>
        <p>
          This advance-cancellation/reschedule benefit is capped at one schedule change per class in
          the package (the same pool a direct reschedule draws from). Once that pool is spent, even
          a 24+-hour cancellation no longer releases the class; the Student may let it ride or ask
          the Teacher to release it manually.
        </p>
        <p>
          Refunds: a class that was not delivered (canceled by the Teacher and not rescheduled) may
          be refunded at the Teacher&apos;s discretion. The Platform facilitates refunds through the
          original payment provider; provider fees are not refunded.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          6. Acceptable use
        </Heading>
        <p>
          You may not: (a) use the Platform for illegal or fraudulent purposes; (b) harass,
          threaten, or discriminate against others; (c) attempt to access other accounts or breach
          the service&apos;s security; (d) automate use of the Platform without written
          authorization; (e) resell or transfer your account.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          7. Suspension and termination
        </Heading>
        <p>
          You may close your account at any time by contacting{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . The Platform may suspend or close an account for breach of these Terms. Paid but
          undelivered classes are handled per Section 5.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          8. Intellectual property
        </Heading>
        <p>
          Materials that a Teacher uploads to the Platform (class plans, exercises, audio, video)
          are the Teacher&apos;s property. The Platform receives a limited, non-exclusive license to
          store and deliver those materials to the Teacher&apos;s Students. The SpiralClass brand,
          site, and code are the Platform&apos;s property.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          9. Limitation of liability
        </Heading>
        <p>
          The Platform is provided &ldquo;as is&rdquo;. To the maximum extent permitted by law, the
          Platform is not liable for indirect damages, lost profits, or data loss. The
          Platform&apos;s total liability to any user for any claim shall not exceed the amount paid
          by that user to the Platform in the 12 months preceding the claim.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          10. Governing law
        </Heading>
        <p>
          These Terms are governed by the laws of England and Wales. Disputes will be resolved
          before the courts of England and Wales, with the parties waiving any other jurisdiction
          that might apply. This does not remove any mandatory consumer protections a Student is
          entitled to under the law of their country of residence.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          11. Changes to these Terms
        </Heading>
        <p>
          We may update these Terms when necessary. Material changes will be announced by email to
          active users at least 15 days before the effective date. Continued use after the effective
          date constitutes acceptance of the updated version.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          12. Video calls and live captions
        </Heading>
        <p>
          Classes are conducted over video call. If you or your teacher turn on live captions, the
          speaker&apos;s audio is sent in real time to a third-party speech-recognition provider and
          a third-party AI translation provider, solely to generate the translated text shown on
          screen; that audio is not stored or used for any other purpose. Captioning your own voice
          requires your explicit consent, which you can give or withdraw at any time from your
          account settings — see our{" "}
          <Link className="underline" href="/privacy-notice">
            privacy notice
          </Link>{" "}
          for more detail.
        </p>
      </section>

      <section className="space-y-2">
        <Heading level={4} as="h2">
          13. Contact
        </Heading>
        <p>
          Questions? Email{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . See also our{" "}
          <Link className="underline" href="/privacy-notice">
            privacy notice
          </Link>
          .
        </p>
      </section>
    </article>
  );
}
