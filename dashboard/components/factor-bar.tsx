'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { bandColor, bandTextClass, scoreBand } from '../app/lib/format';
import type { RiskFactor } from '../app/lib/contract';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * One factor row on the detail page: name + weight, the value, the animated
 * fill bar (grades against the 0–100 safety scale), and — the actual product —
 * the real `detail` string explaining why the number is what it is.
 */
export function FactorCard({
  label,
  factor,
  index = 0,
}: {
  label: string;
  factor: RiskFactor | null;
  index?: number;
}) {
  const reduce = useReducedMotion();

  if (factor === null) {
    return (
      <div className="surface-lit rounded-xl border border-line-soft p-5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-medium text-ink">{label}</span>
          <span className="tnum text-sm text-faint">N/A</span>
        </div>
        <p className="mt-3 text-sm italic text-faint">Not applicable to this protocol.</p>
      </div>
    );
  }

  const band = scoreBand(factor.value);
  const pct = Math.max(0, Math.min(100, factor.value));

  return (
    <div className="surface-lit rounded-xl border border-line p-5 transition-colors hover:border-line/80">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-ink">
          {label}
          <span className="ml-2 text-xs font-normal text-faint">
            weight {Math.round(factor.weight * 100)}%
          </span>
        </span>
        <span className={`tnum text-lg font-semibold ${bandTextClass(band)}`}>{factor.value}</span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
        <motion.div
          className="h-full rounded-full"
          style={{ background: bandColor(band) }}
          initial={{ width: reduce ? `${pct}%` : 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.05 * index }}
        />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted">{factor.detail}</p>

      {factor.components && factor.components.length > 0 && (
        <ul className="mt-4 space-y-2.5 border-t border-line-soft pt-3.5">
          {factor.components.map((c) => (
            <li key={c.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-muted">{c.label}</span>
                {c.value === null ? (
                  // A null component is a deliberate disclosure, not missing data —
                  // say so rather than rendering a bare dash the reader must guess at.
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">
                    not scored
                  </span>
                ) : (
                  <span
                    className={`tnum shrink-0 text-sm font-semibold ${bandTextClass(
                      scoreBand(c.value),
                    )}`}
                  >
                    {c.value}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-faint">{c.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
