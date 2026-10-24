import type { RotationInput } from '../types';

export function damageShare(dealers: number, extras: number, contribution: number) {
    if (
        !Number.isInteger(dealers) ||
        dealers < 1 ||
        !Number.isInteger(extras) ||
        extras < 0 ||
        !Number.isFinite(contribution) ||
        contribution < 0 ||
        contribution > 100
    )
        throw Error(
            'Use at least one damage dealer, whole additional players and 0–100% contribution.'
        );
    return 1 / (dealers + (extras * contribution) / 100);
}

export function addPreparation(
    rotation: RotationInput,
    phases: any[],
    wars: number,
    travel: number,
    dummy: number
) {
    if (![wars, travel, dummy].every((n) => Number.isInteger(n) && n >= 0) || wars < 1)
        throw Error(
            'Use whole ticks: at least one Wars tick and non-negative travel and dummy time.'
        );
    rotation.targetCounts ??= Array(300).fill(null);
    rotation.tickEvents ??= Array(300).fill(null);
    const fight = wars + travel + dummy;
    if (fight >= 300) throw Error('Leave room for fighting within the 300-tick timeline.');
    let ordered = phases
        .filter((p) => !/^(wars|war.s retreat|travel|prebuild)$/i.test(p.name.trim()))
        .sort((a, b) => a.tick - b.tick);
    const oldStart = ordered[0]?.tick ?? 0;
    const offset = fight - oldStart;
    // Keep scripted gear, consumables and target conditions aligned with their fight section.
    for (const key of [
        'abilityBar',
        'stalledAbilities',
        'releasedAbilities',
        'extraActionBar',
        'tickEvents',
        'targetCounts',
        'nulledTicks'
    ] as const) {
        const values = rotation[key];
        if (!values) continue;
        const before = structuredClone(values);
        for (let t = 0; t < 300; t++)
            (values as any)[t] =
                key === 'extraActionBar' ? [] : key === 'nulledTicks' ? false : null;
        for (let t = oldStart; t < before.length; t++) {
            const value = before[t];
            const occupied = Array.isArray(value) ? value.length > 0 : !!value;
            if (t + offset >= 300) {
                if (occupied)
                    throw Error(
                        'Preparation would push an existing action beyond tick 299. Shorten it first.'
                    );
            } else (values as any)[t + offset] = value;
        }
    }
    ordered = ordered.map((p) => ({ ...p, tick: p.tick - oldStart + fight }));
    if (!ordered.length)
        ordered = [{ tick: fight, name: 'Phase 1', downtime: 0, clearStacks: [], damage: 0 }];
    if (ordered.some((p) => p.tick >= 300))
        throw Error('A shifted phase falls beyond tick 299. Shorten preparation.');
    for (let t = 0; t < fight; t++) {
        rotation.extraActionBar[t] = [];
        rotation.tickEvents![t] = null;
        rotation.targetCounts[t] = null;
        rotation.nulledTicks[t] = false;
    }
    const section = (tick: number, name: string, stage: 'dummy' | 'travel' | 'fight') => {
        rotation.tickEvents![tick] = { ...rotation.tickEvents![tick], encounterStage: stage };
        if (stage !== 'fight')
            ordered.push({ tick, name, downtime: 0, clearStacks: [], damage: 0 });
    };
    section(0, 'Wars', 'dummy');
    Object.assign(rotation.tickEvents![0]!, {
        target: 'none',
        automaticAccuracy: false,
        accuracy: 100
    });
    rotation.targetCounts[0] = 1;
    if (travel) section(wars, 'Travel', 'travel');
    if (dummy) section(wars + travel, 'Prebuild', 'dummy');
    section(fight, 'Phase 1', 'fight');
    return { fight, phases: ordered.sort((a, b) => a.tick - b.tick) };
}
