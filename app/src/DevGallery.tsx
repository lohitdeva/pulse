import { useState, type ReactNode } from "react";
import {
  BottomTabs,
  Card,
  IconChip,
  ListRow,
  RingGauge,
  Sheet,
  StatTile,
  TrendChip,
  type TabName,
} from "./ui";

type GlyphName = "spark" | "bolt" | "sun" | "leaf" | "calendar" | "check";

const glyphContents: Record<GlyphName, ReactNode> = {
  spark: <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />,
  bolt: <path d="M13 2 5.8 12h4.7L10 22l8.2-11h-4.8L13 2Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
  leaf: <><path d="M19.5 4.5c-7.3 0-12 2.3-12 7a5 5 0 0 0 5 5c4.7 0 7-4.7 7-12Z" /><path d="M4 20c2-5 5-8 10-11" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  check: <path d="m5 12 4 4L19 6" />,
};

function Glyph({ name }: { name: GlyphName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {glyphContents[name]}
    </svg>
  );
}

export function DevGallery() {
  const [activeTab, setActiveTab] = useState<TabName>("Today");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <main className="gallery-shell">
      <header className="gallery-header">
        <div className="gallery-heading">
          <p className="eyebrow">PULSE · COMPONENTS</p>
          <h1>UI gallery</h1>
          <p>A small, interactive look at the building blocks.</p>
        </div>
        <span className="gallery-status">Local preview</span>
      </header>

      <p className="gallery-active" aria-live="polite">Previewing {activeTab}</p>

      <div className="gallery-grid">
        <section className="gallery-section" aria-labelledby="section-card-gauge">
          <SectionHeading id="section-card-gauge" title="Card + RingGauge" detail="A quick daily read" />
          <Card className="gallery-hero">
            <div className="hero-copy">
              <div className="hero-title-line">
                <div>
                  <p className="section-kicker">TUESDAY, NOVEMBER 26</p>
                  <h2>Your rhythm, at a glance</h2>
                </div>
                <TrendChip value="+8%" direction="up" label="8 percent above your weekly average" />
              </div>
              <p>Steady progress across your focus, movement, and recovery.</p>
            </div>
            <div className="hero-main">
              <Card className="gauge-card">
                <RingGauge value={72} max={100} label="Daily score" unit="of 100" valueLabel="72" />
              </Card>
              <div className="stat-grid">
                <StatTile label="Focus" value="3.8" unit="h" icon={<Glyph name="spark" />} accent="blue" />
                <StatTile label="Movement" value="6.2" unit="k steps" icon={<Glyph name="bolt" />} accent="mint" />
                <StatTile label="Sleep" value="7.4" unit="h" icon={<Glyph name="sun" />} accent="orange" />
                <StatTile label="Habits" value="4/5" icon={<Glyph name="check" />} accent="red" />
              </div>
            </div>
          </Card>
        </section>

        <section className="gallery-section gallery-section-half" aria-labelledby="section-list-row">
          <SectionHeading id="section-list-row" title="ListRow" detail="Tap a row to interact" />
          <Card className="example-stack">
            <ListRow
              label="Morning walk"
              hint="Movement · 24 min"
              value="Done"
              icon={<Glyph name="check" />}
              onClick={() => setMessage("Morning walk opened")}
            />
            <ListRow
              label="Read for 20 minutes"
              hint="Learning · planned for 8:30 PM"
              value="8:30 PM"
              icon={<Glyph name="calendar" />}
              onClick={() => setMessage("Reading reminder selected")}
            />
            <p className="toast-message" aria-live="polite">{message}</p>
          </Card>
        </section>

        <section className="gallery-section gallery-section-half" aria-labelledby="section-controls">
          <SectionHeading id="section-controls" title="IconChip + TrendChip" detail="Accessible action controls" />
          <Card className="example-action">
            <div className="control-demo-line">
              <IconChip
                label="Mark today as a favorite"
                icon={<Glyph name="leaf" />}
                tone="mint"
                onClick={() => setMessage("Today marked as a favorite")}
              />
              <div>
                <span className="stat-label">Weekly energy</span>
                <strong className="control-value">Feeling good</strong>
              </div>
              <TrendChip value="+5%" direction="up" />
            </div>
            <p>Icon actions keep a 44 px target and include a screen-reader label.</p>
            <button className="button button-secondary" type="button" onClick={() => setSheetOpen(true)}>
              Open the sheet
            </button>
          </Card>
        </section>

        <section className="gallery-section gallery-section-third" aria-labelledby="section-surface">
          <SectionHeading id="section-surface" title="Surface" detail="Card primitive" />
          <Card className="surface-demo">
            <span className="icon-chip icon-chip-blue" aria-hidden="true"><Glyph name="spark" /></span>
            <h3>Quiet momentum</h3>
            <p>One well-sized card for a single useful thought.</p>
          </Card>
        </section>

        <section className="gallery-section gallery-section-third" aria-labelledby="section-trend">
          <SectionHeading id="section-trend" title="Trend states" detail="Positive, neutral, caution" />
          <Card className="trend-demo">
            <TrendChip value="+12%" direction="up" />
            <TrendChip value="0%" direction="flat" />
            <TrendChip value="−4%" direction="down" />
          </Card>
        </section>

        <section className="gallery-section gallery-section-third" aria-labelledby="section-tabs">
          <SectionHeading id="section-tabs" title="BottomTabs" detail="Five primary destinations" />
          <Card className="tab-note">
            <p>Choose any tab below to update the preview state.</p>
            <span className="active-tab-label">Active: {activeTab}</span>
          </Card>
        </section>
      </div>

      <BottomTabs activeTab={activeTab} onChange={setActiveTab} />

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="A little more context"
        description="Sheets keep supporting actions close at hand on smaller screens."
      >
        <p>Your focus block is scheduled for 8:30 PM. It is a good time to finish one small task and then wind down.</p>
        <button className="button button-primary" type="button" onClick={() => setSheetOpen(false)}>
          Got it
        </button>
      </Sheet>
    </main>
  );
}

function SectionHeading({ id, title, detail }: { id: string; title: string; detail: string }) {
  return (
    <div className="gallery-section-heading">
      <h2 id={id}>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
