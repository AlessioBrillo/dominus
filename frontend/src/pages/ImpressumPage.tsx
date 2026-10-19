// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';

export function ImpressumPage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Impressum</h1>
      <p className="text-text-muted text-sm">Angaben gemäß § 5 TMG (Deutschland)</p>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Anbieter</h2>
        <p className="text-text-secondary">
          Alessio Brillo
          <br />
          Projekt: DOMINUS
          <br />
          E-Mail: privacy@dominus.example
          <br />
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Haftungsausschluss</h2>
        <p className="text-text-secondary">
          DOMINUS ist eine Open-Source-Software zur Unterstützung von Entscheidungen beim
          Domain-Investing. Die bereitgestellten Bewertungen, Kaufpreise und Empfehlungen stellen
          keine Anlageberatung dar. Die Nutzung erfolgt auf eigene Gefahr.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Hinweis zur Datenverarbeitung</h2>
        <p className="text-text-secondary">
          Die detaillierten Informationen zur Verarbeitung personenbezogener Daten finden Sie in
          unserer
          <Link to="/privacy">Datenschutzerklärung</Link>.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Verantwortlicher für den Inhalt</h2>
        <p className="text-text-secondary">
          Die Inhalte dieser Seiten werden vom Projektbetreiber erstellt. Für Inhalte verlinkter
          externer Websites ist der jeweilige Anbieter verantwortlich.
        </p>
      </section>

      <div className="pt-8 flex gap-3">
        <Button asChild>
          <Link to="/terms">Terms of Service</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/privacy">Privacy Policy</Link>
        </Button>
      </div>
    </div>
  );
}
