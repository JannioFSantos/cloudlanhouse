/**
 * Tabela de preços — regra combinada:
 *
 *   1ª hora: R$ 7,00
 *   2ª hora: R$ 6,00   (-1)
 *   3ª hora: R$ 5,00   (-1)
 *   4ª hora: R$ 4,00   (-1)
 *   Máximo:  4 horas
 *
 * Cada hora adicional precisa ser comprada ANTES de a hora atual terminar.
 * Depois que o tempo acaba, a sessão morre e o slot abre para outra pessoa.
 */

export const HOURLY_CENTS = Object.freeze([700, 600, 500, 400]);
export const MAX_HOURS = HOURLY_CENTS.length;

/** Preço da enésima hora (0-based). null se passar do limite. */
export function priceForHour(hourIndex) {
  return HOURLY_CENTS[hourIndex] ?? null;
}

/**
 * Cotação de um pacote.
 * @param {number} purchasedHours quantas horas a sessão já comprou
 * @param {number} extraHours     quantas horas estão sendo compradas agora
 */
export function quote(purchasedHours, extraHours) {
  const already = Math.max(0, Math.trunc(purchasedHours));
  const extra = Math.trunc(extraHours);

  if (!Number.isFinite(extra) || extra < 1) {
    return { ok: false, code: 'invalid_hours', message: 'Escolha pelo menos 1 hora.' };
  }
  if (already + extra > MAX_HOURS) {
    return {
      ok: false,
      code: 'max_hours',
      message: `O limite é ${MAX_HOURS} horas por sessão (${already} já compradas).`,
      maxExtra: Math.max(0, MAX_HOURS - already),
    };
  }

  const breakdown = [];
  for (let i = 0; i < extra; i++) {
    const hourNumber = already + i + 1;
    breakdown.push({ hourNumber, cents: priceForHour(already + i) });
  }

  return {
    ok: true,
    amountCents: breakdown.reduce((sum, b) => sum + b.cents, 0),
    breakdown,
    totalHoursAfter: already + extra,
    nextHourCents: priceForHour(already + extra),
  };
}

/** Quanto custa a próxima hora a partir de N horas já compradas. */
export function nextHourPrice(purchasedHours) {
  return priceForHour(purchasedHours);
}
