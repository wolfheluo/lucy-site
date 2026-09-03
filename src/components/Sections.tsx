// =====================================================================
//  頁面段落：Hero / About / Skills / Projects / Contact
// =====================================================================
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router";
import type { MouseEvent, ReactNode } from "react";
import GlitchText from "./GlitchText";
import { about, contact, profile, projects, skills } from "../content";
import { toolProjectCards } from "../tools";
import { useNavTransition } from "./RouteTransition";

/* 捲入視野時淡入上移（respect reduced-motion） */
function FadeIn({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const rm = useReducedMotion();
  if (rm) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.75, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

function SectionHead({ en, zh, instant }: { en: string; zh: string; instant: boolean }) {
  return (
    <div className="sec-head">
      <h2 className="display-en">
        <GlitchText text={en} instant={instant} hover />
        <span className="zh">{zh}</span>
      </h2>
      <span className="rule" />
    </div>
  );
}

/* ---------------- Hero ---------------- */
export function Hero({ startDecode, instant }: { startDecode: boolean; instant: boolean }) {
  return (
    <section id="hero" className="sec">
      <div className="sec-inner">
        <GlitchText
          className="hero-name"
          text={profile.name}
          start={startDecode}
          delayMs={480}
          instant={instant}
          hover
        />
        <GlitchText
          className="hero-alt"
          text={profile.altName}
          start={startDecode}
          delayMs={1050}
          instant={instant}
          hover
        />

        {instant ? (
          <>
            <p className="hero-role">{profile.roleEn}</p>
            <p
              className="hero-tag"
              dangerouslySetInnerHTML={{ __html: profile.tagline }}
            />
          </>
        ) : (
          <>
            <motion.p
              className="hero-role"
              initial={{ opacity: 0, y: 14 }}
              animate={startDecode ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 1.5, duration: 0.7, ease: "easeOut" }}
            >
              {profile.roleEn}
            </motion.p>
            <motion.p
              className="hero-tag"
              initial={{ opacity: 0, y: 14 }}
              animate={startDecode ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 1.75, duration: 0.7, ease: "easeOut" }}
              dangerouslySetInnerHTML={{ __html: profile.tagline }}
            />
          </>
        )}

        <div className="hero-scroll">SCROLL TO DIVE</div>
      </div>
    </section>
  );
}

/* ---------------- About ---------------- */
export function AboutSec({ instant }: { instant: boolean }) {
  return (
    <section id="about" className="sec">
      <div className="sec-inner">
        <FadeIn>
          <SectionHead en={about.headingEn} zh={about.headingZh} instant={instant} />
        </FadeIn>
        <FadeIn delay={0.08}>
          {about.paragraphs.map((p, i) => (
            <p
              key={i}
              className="body-text"
              style={{ maxWidth: "62ch" }}
              dangerouslySetInnerHTML={{ __html: p }}
            />
          ))}
        </FadeIn>
        <FadeIn delay={0.16}>
          <div className="stat-grid">
            {about.stats.map((s) => (
              <div className="stat glass" key={s.label} data-hover>
                <div className="v">{s.value}</div>
                <div className="l">{s.label}</div>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ---------------- Skills ---------------- */
export function SkillsSec({ instant }: { instant: boolean }) {
  return (
    <section id="skills" className="sec">
      <div className="sec-inner">
        <FadeIn>
          <SectionHead en={skills.headingEn} zh={skills.headingZh} instant={instant} />
        </FadeIn>
        <FadeIn delay={0.08}>
          <p className="body-text" style={{ maxWidth: "40ch", marginBottom: "2rem" }}>
            {skills.intro}
          </p>
        </FadeIn>
        <div className="skills-list">
          {skills.groups.map((g, gi) => (
            <FadeIn key={g.title} delay={0.1 + gi * 0.08}>
              <div className="sk-group">
                <div className="g-title">{g.title}</div>
                <div className="chips">
                  {g.items.map((it) => (
                    <span className="chip" key={it}>
                      {it}
                    </span>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Projects ---------------- */
type ProjectCardData = {
  idx: string;
  title: string;
  zh: string;
  desc: string;
  tags: string[];
  href?: string;
};

function ProjectCard({ p }: { p: ProjectCardData }) {
  const navTransition = useNavTransition();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // 一般左鍵無修飾鍵 → 深潛過場；中鍵/新分頁/無障礙保留原生行為
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navTransition(p.href!, p.title);
  };

  const inner = (
    <>
      <div className="p-idx">{p.idx}</div>
      <h3 className="p-title">
        {p.title}
        <span className="zh">{p.zh}</span>
      </h3>
      <p className="p-desc">{p.desc}</p>
      <div className="p-tags">
        {p.tags.map((t) => (
          <span className="tag" key={t}>
            {t}
          </span>
        ))}
      </div>
    </>
  );

  if (p.href) {
    return (
      <Link className="pcard glass clickable" to={p.href} data-hover onClick={handleClick}>
        {inner}
      </Link>
    );
  }
  return (
    <article className="pcard glass" data-hover>
      {inner}
    </article>
  );
}

export function ProjectsSec({ instant }: { instant: boolean }) {
  const manual: ProjectCardData[] = projects.items.map((p) => ({ ...p, href: undefined }));
  const cards: ProjectCardData[] = [...manual, ...toolProjectCards(projects.items.length)];
  return (
    <section id="projects" className="sec sec-right">
      <div className="sec-inner">
        <FadeIn>
          <SectionHead en={projects.headingEn} zh={projects.headingZh} instant={instant} />
        </FadeIn>
        <div className="cards">
          {cards.map((p, i) => (
            <FadeIn key={p.idx} delay={0.1 + i * 0.12}>
              <ProjectCard p={p} />
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Contact ---------------- */
export function ContactSec({ instant }: { instant: boolean }) {
  return (
    <section id="contact" className="sec">
      <div className="sec-inner">
        <FadeIn>
          <SectionHead en={contact.headingEn} zh={contact.headingZh} instant={instant} />
        </FadeIn>
        <FadeIn delay={0.08}>
          <p className="body-text" style={{ maxWidth: "52ch" }}>
            {contact.line}
          </p>
          <p className="contact-note" style={{ maxWidth: "52ch" }}>
            {contact.note}
          </p>
        </FadeIn>
        <FadeIn delay={0.14}>
          <a className="big-mail" href={`mailto:${contact.email}`} data-hover>
            {contact.email}
          </a>
        </FadeIn>
        <FadeIn delay={0.2}>
          <div className="socials">
            {contact.socials.map((s) => (
              <a
                className="soc"
                key={s.label}
                href={s.href}
                target={s.href.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                data-hover
                onMouseEnter={() => {
                  /* hover handled by custom cursor */
                }}
              >
                {s.label}
              </a>
            ))}
          </div>
        </FadeIn>
        <FadeIn delay={0.26}>
          <footer className="foot">
            <span>
              © {new Date().getFullYear()} {profile.handle.toUpperCase()}
            </span>
            <span>BUILT WITH R3F · 致敬 LUCY // CYBERPUNK: EDGERUNNERS</span>
          </footer>
        </FadeIn>
      </div>
    </section>
  );
}

export default function Sections({ booted, instant }: { booted: boolean; instant: boolean }) {
  return (
    <>
      <Hero startDecode={booted} instant={instant} />
      <AboutSec instant={instant} />
      <SkillsSec instant={instant} />
      <ProjectsSec instant={instant} />
      <ContactSec instant={instant} />
    </>
  );
}
