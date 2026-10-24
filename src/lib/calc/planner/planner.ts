import { abils, ABILITIES } from '$lib/data/abilities';
import { abilityReference } from '$lib/data/abilityReference';
import { getEquipment, equipmentMechanicId } from '$lib/data/equipment';
import { ARMOUR } from '$lib/data/armour';
import { SETTINGS } from '../settings_rb';
import { style_specific_unification } from '../damage_calc_rb';
import {
    calculateRotationDamageCore,
    resolveTumekensAsphyxiate
} from '../rotation_builder/rotation-damage-calculator';
import { COOLDOWN_PREFIX } from '../rotation_builder/damage_calc_new';
import { applyActionAmmo } from '../rotation_builder/quiver';
import type { RotationInput } from '../types';

export type Choice = { ability: string | null; ammo?: number };
export interface PlannerInput {
    settings: Record<string, any>;
    rotation: RotationInput;
    abilities: string[];
    ammo: number[];
    start: number;
    end: number;
    objective: 'damage' | 'time';
    goal: number;
    scope: 'main' | 'all';
    iterations: number;
    seconds: number;
    seed: number;
    stayInBurst?: boolean;
    stackDetours?: boolean;
    phaseGoals?: { name: string; start: number; end: number; damage: number }[];
}
export interface Plan {
    rotation: RotationInput;
    genes: Choice[];
    damage: number;
    reached: number | null;
    curve: number[];
    casts: number;
    valid: boolean;
    reason?: string;
    phaseOutcomes?: { name: string; damage: number; goal: number; reached: number | null }[];
    phaseShortfall?: number;
}

export function requiredAdrenaline(key: string, s: Record<string, any>) {
    const a = abils[key];
    if (!a || !['threshold', 'ultimate', 'special attack'].includes(a.abilityType)) return 0;
    if (a.mainStyle === 'ranged' && s[SETTINGS.DEATHSPORE_BUFF]) return 0;
    let cost = a.adrenaline ?? (a.abilityType === 'ultimate' ? 100 : 0);
    if (key === ABILITIES.TSUNAMI)
        cost = Math.floor(cost * (1 - 0.12 * (s[SETTINGS.GLACIAL_EMBRACE] || 0)));
    if (key === ABILITIES.FINGER_OF_DEATH)
        cost -= Math.min(6, s[SETTINGS.NECROSIS_STACKS] || 0) * 10;
    if (a.abilityType === 'special attack') {
        if (s[SETTINGS.VIGOUR]) cost *= 0.9;
        if (key === ABILITIES.ICY_TEMPEST) cost -= (s[SETTINGS.PRIMORDIAL_ICE] || 0) * 12;
    }
    if (a.mainStyle === 'magic') {
        for (const [buff, reduction] of [
            [SETTINGS.GREATER_FLOW_AC, 45],
            [SETTINGS.FLOW_AC, 35],
            [SETTINGS.GREATER_FLOW, 20],
            [SETTINGS.FLOW, 10]
        ] as const) {
            if (s[buff]) {
                cost = Math.floor(cost - reduction);
                break;
            }
        }
    }
    // Ultimate refunds cannot pay the activation requirement.
    return Math.max(0, cost);
}
const normal = (value: string) =>
    value
        .toLowerCase()
        .replace(/^augmented /, '')
        .replace(/[^a-z0-9]/g, '');
const referenceByName = new Map(Object.values(abilityReference).map((r) => [normal(r.name), r]));
export function equipmentAllows(
    key: string,
    settings: Record<string, any>,
    approvedSpecial = false
) {
    const a = abils[key];
    if (!a) return false;
    const s = { ...settings };
    style_specific_unification(s, a.mainStyle);
    const ref = abilityReference[key] ?? referenceByName.get(normal(a.title ?? key));
    const requirement = ref?.equipment?.toLowerCase() ?? '';
    const twoHand = s[SETTINGS.WEAPON] === SETTINGS.WEAPON_VALUES.TH;
    if (requirement.includes('dual wield') && twoHand) return false;
    if (requirement.includes('two-handed') && !twoHand) return false;
    if (a.abilityType === 'special attack') {
        const weapon = getEquipment(equipmentMechanicId(s[twoHand ? SETTINGS.TH : SETTINGS.MH]));
        const native =
            weapon && a.specialWeapon && normal(a.specialWeapon).includes(normal(weapon.name));
        const neck = equipmentMechanicId(s[SETTINGS.NECKLACE]);
        return !!native || (approvedSpecial && [ARMOUR.EOF, ARMOUR.EOF_OR].includes(neck));
    }
    return true;
}
export function plannerAbilities(settings: Record<string, any>, styles: string[]) {
    return Object.entries(abils)
        .filter(
            ([key, a]) =>
                a.title &&
                !a.parent &&
                styles.includes(a.mainStyle) &&
                a.duration !== 0 &&
                !['proc', 'perk', 'conjure'].includes(a.abilityClassification) &&
                ![
                    ABILITIES.ASSAULT_BARGE,
                    ABILITIES.FLURRY_BARGE,
                    ABILITIES.GREATER_FLURRY_BARGE
                ].includes(key as ABILITIES) &&
                !key.includes('flank') &&
                !key.startsWith('command ') &&
                !key.startsWith('conjure ') &&
                ![
                    'soul crush',
                    'spectral scythe 2',
                    'spectral scythe 3',
                    ABILITIES.DEATHSKULLS_7
                ].includes(key) &&
                !/^volley of souls \d+$/.test(key) &&
                equipmentAllows(key, settings, true)
        )
        .map(([key]) => key);
}
const burstBuffs: [string, string][] = [
    [SETTINGS.BERSERK, 'melee'],
    [SETTINGS.DEATH_SWIFTNESS, 'ranged'],
    [SETTINGS.SUNSHINE, 'magic'],
    [SETTINGS.LIVING_DEATH, 'necromancy']
];
export function burstStyle(settings: Record<string, any>, previous?: string) {
    if (previous && burstBuffs.some(([key, style]) => style === previous && settings[key] === true))
        return previous;
    return burstBuffs.find(([key]) => settings[key] === true)?.[1];
}
export function allowsBurstChoice(
    key: string | null,
    s: Record<string, any>,
    focus: string | undefined,
    detoured: boolean,
    detours: boolean
) {
    if (!key || !focus || abils[key].mainStyle === focus) return true;
    if (!detours || detoured || abils[key].abilityType !== 'basic') return false;
    const style = abils[key].mainStyle;
    if (style === 'melee')
        return (s[SETTINGS.BLOODLUST_STACKS] ?? 0) < (s[SETTINGS.BERSERK] ? 8 : 4);
    if (style === 'ranged') {
        const ranged = { ...s };
        style_specific_unification(ranged, 'ranged');
        const weapon = getEquipment(equipmentMechanicId(ranged[SETTINGS.TH]));
        return (
            (ranged[SETTINGS.AMMO] === ARMOUR.WEN_ARROWS &&
                (s[SETTINGS.ICY_CHILL_STACKS] ?? 0) < 10) ||
            (ranged[SETTINGS.AMMO] === ARMOUR.DEATHSPORE_ARROWS &&
                (s[SETTINGS.DEATHSPORE_STACKS] ?? 0) < 5) ||
            (ranged[SETTINGS.AMMO] === ARMOUR.BIK_ARROWS && (s[SETTINGS.BIK_STACKS] ?? 0) < 150) ||
            (/bow of the last guardian/i.test(weapon?.name ?? '') &&
                (s[SETTINGS.PERFECT_EQUILIBRIUM_STACKS] ?? 0) < 7)
        );
    }
    if (style === 'magic')
        return (
            (s[SETTINGS.AUTO_CAST] === SETTINGS.AUTO_CAST_VALUES.EXSANGUINATE &&
                (s[SETTINGS.BLOOD_TITHE] ?? 0) < 12) ||
            (s[SETTINGS.AUTO_CAST] === SETTINGS.AUTO_CAST_VALUES.INCITE_FEAR &&
                (s[SETTINGS.GLACIAL_EMBRACE] ?? 0) < 5)
        );
    if (style === 'necromancy')
        return (
            (key === ABILITIES.TOUCH_OF_DEATH && (s[SETTINGS.NECROSIS_STACKS] ?? 0) < 12) ||
            (key === ABILITIES.SOUL_SAP && (s[SETTINGS.RESIDUAL_SOULS] ?? 0) < 5)
        );
    return false;
}
const cooldownFamily = (key: string) =>
    key.replace(/^greater /, '').replace(/(death skulls) \d+$/, '$1');
const cooldownAliases = new Map<string, string[]>();
for (const key of Object.keys(abils)) {
    const family = cooldownFamily(key);
    cooldownAliases.set(family, [...(cooldownAliases.get(family) ?? []), key]);
}
function canUse(
    choice: Choice,
    s: Record<string, any>,
    timers: Record<string, number>,
    allowed: Set<string>
) {
    const key = choice.ability;
    if (!key) return true;
    if (!allowed.has(key) || !equipmentAllows(key, s, true)) return false;
    const check = { ...s, _quiverSlots: { ...s._quiverSlots } };
    applyActionAmmo(check, choice.ammo);
    style_specific_unification(check, abils[key].mainStyle);
    if (
        (cooldownAliases.get(cooldownFamily(key)) ?? [key]).some(
            (alias) => (timers[COOLDOWN_PREFIX + alias] ?? 0) > 1
        )
    )
        return false;
    if ((check[SETTINGS.ADRENALINE] ?? 0) + 1e-8 < requiredAdrenaline(key, check)) return false;
    if (key === ABILITIES.SOUL_STRIKE && (check[SETTINGS.RESIDUAL_SOULS] ?? 0) < 1) return false;
    if (
        [ABILITIES.VOLLEY_OF_SOULS, ABILITIES.VOLLEY_OF_SOULS_DYNAMIC].includes(key as ABILITIES) &&
        (check[SETTINGS.RESIDUAL_SOULS] ?? 0) < 2
    )
        return false;
    return true;
}
export function scoreImpacts(
    impacts: number[],
    input: Pick<PlannerInput, 'start' | 'end' | 'goal'>
) {
    let damage = 0,
        reached: number | null = null;
    const curve: number[] = [];
    for (let t = input.start; t < input.end; t++) {
        damage += impacts[t] ?? 0;
        curve.push(damage);
        if (reached === null && damage >= input.goal) reached = t - input.start;
    }
    return { damage, reached, curve };
}
export function comparePlans(a: Plan, b: Plan, objective: PlannerInput['objective']) {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    if ((a.phaseShortfall ?? 0) !== (b.phaseShortfall ?? 0))
        return (a.phaseShortfall ?? 0) - (b.phaseShortfall ?? 0);
    if (objective === 'time') {
        if (a.reached !== null && b.reached === null) return -1;
        if (a.reached === null && b.reached !== null) return 1;
        if (a.reached !== null && b.reached !== null && a.reached !== b.reached)
            return a.reached - b.reached;
    }
    return b.damage - a.damage || a.casts - b.casts;
}
function randomSource(seed: number) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function duration(key: string, s: Record<string, any>) {
    if (
        s[SETTINGS.ENDLESS_ASSAULT] &&
        [ABILITIES.ASSAULT, ABILITIES.FLURRY, ABILITIES.GREATER_FLURRY].includes(key as ABILITIES)
    )
        return 3;
    return Math.max(3, abils[resolveTumekensAsphyxiate(key, s)]?.duration ?? 3);
}
export function validatePlanner(input: PlannerInput) {
    if (
        !Number.isInteger(input.start) ||
        !Number.isInteger(input.end) ||
        input.start < 0 ||
        input.end > 300 ||
        input.end <= input.start
    )
        throw Error('Choose a valid tick range within ticks 0-299.');
    if (!Number.isFinite(input.goal) || input.goal <= 0)
        throw Error('Enter a positive damage target.');
    if (!input.abilities.length || input.abilities.some((key) => !abils[key]))
        throw Error('Choose at least one available ability.');
    if (
        !Number.isInteger(input.iterations) ||
        input.iterations < 1 ||
        input.iterations > 10000 ||
        !Number.isFinite(input.seconds) ||
        input.seconds < 1 ||
        input.seconds > 300
    )
        throw Error('Choose a search budget from 1-300 seconds and 1-10000 trials.');
    if (
        input.phaseGoals?.some(
            (p) =>
                !Number.isInteger(p.start) ||
                !Number.isInteger(p.end) ||
                p.start < input.start ||
                p.end > input.end ||
                p.end <= p.start ||
                !Number.isFinite(p.damage) ||
                p.damage <= 0
        )
    )
        throw Error('Phase requirements need a valid window and positive damage.');
    // A generated segment cannot begin inside an already-running channel/GCD.
    for (let t = 0; t < input.start; t++) {
        const key = input.rotation.abilityBar[t] ?? input.rotation.stalledAbilities[t];
        if (key && t + (abils[key]?.duration ?? 3) > input.start)
            throw Error('Start after the previous ability or channel finishes.');
    }
}

export function evaluatePlan(
    input: PlannerInput,
    genes: Choice[],
    seed: number,
    generate = true
): Plan {
    const rotation = structuredClone(input.rotation);
    const allowed = new Set(input.abilities);
    const choices: Choice[] = input.abilities.flatMap((ability) =>
        abils[ability].mainStyle === 'ranged' && input.ammo.length
            ? input.ammo.map((ammo) => ({ ability, ammo }))
            : [{ ability }]
    );
    const random = randomSource(seed);
    const output: Choice[] = [];
    let next = input.start,
        decision = 0,
        valid = true,
        reason = '';
    let focus: string | undefined,
        detoured = false;
    let pendingDetour: { tick: number; before: Record<string, number> } | undefined;
    const stackKeys: Record<string, string[]> = {
        melee: [SETTINGS.BLOODLUST_STACKS, SETTINGS.PRIMORDIAL_ICE],
        ranged: [
            SETTINGS.ICY_CHILL_STACKS,
            SETTINGS.PERFECT_EQUILIBRIUM_STACKS,
            SETTINGS.DEATHSPORE_STACKS,
            SETTINGS.BIK_STACKS
        ],
        magic: [SETTINGS.BLOOD_TITHE, SETTINGS.GLACIAL_EMBRACE, SETTINGS.ESSENCE_CORRUPTION],
        necromancy: [SETTINGS.NECROSIS_STACKS, SETTINGS.RESIDUAL_SOULS]
    };
    function checkDetour(tick: number, s: any) {
        if (pendingDetour && tick >= pendingDetour.tick + 3) {
            if (
                !Object.entries(pendingDetour.before).some(
                    ([key, before]) => (s[key] ?? 0) > before
                )
            ) {
                valid = false;
                reason = 'A mid-burst detour did not build stacks.';
            }
            pendingDetour = undefined;
        }
    }

    function policy(choice: Choice, s: any) {
        const check = { ...s, _quiverSlots: { ...s._quiverSlots } };
        applyActionAmmo(check, choice.ammo);
        return (
            !input.stayInBurst ||
            allowsBurstChoice(choice.ability, check, focus, detoured, !!input.stackDetours)
        );
    }
    function remember(choice: Choice, s: any) {
        const updated = burstStyle(s, focus);
        if (updated !== focus) detoured = false;
        focus = updated;
        if (choice.ability && focus) detoured = abils[choice.ability].mainStyle !== focus;
    }
    if (generate)
        for (let t = input.start; t < input.end; t++) {
            rotation.abilityBar[t] = null;
            rotation.stalledAbilities[t] = null;
            if (rotation.releasedAbilities) rotation.releasedAbilities[t] = null;
            if (rotation.tickEvents?.[t]) delete rotation.tickEvents[t]!.castAmmo;
        }
    // Seed the activity bounds for the dynamic construction pass. The final static
    // replay below always calculates familiar uptime from the actual chosen casts.
    if (generate) rotation.abilityBar[input.end - 1] = input.abilities[0];
    const settings = {
        ...input.settings,
        [SETTINGS.CALC_TYPE]: SETTINGS.CALC_TYPE_VALUES.ROTATION
    };
    const select = (tick: number, s: any, timers: any, rot?: RotationInput, state?: any) => {
        if (!generate) checkDetour(tick, s);
        if (!rot || tick < input.start || tick >= input.end) return;
        if (generate) rot.abilityBar[tick] = null;
        if (generate && tick < next) return;
        if (!generate) {
            const updated = burstStyle(s, focus);
            if (updated !== focus) detoured = false;
            focus = updated;
            const ability = rot.abilityBar[tick];
            if (
                ability &&
                (tick < next ||
                    !canUse(
                        { ability, ammo: rot.tickEvents?.[tick]?.castAmmo },
                        s,
                        timers,
                        allowed
                    ) ||
                    !policy({ ability, ammo: rot.tickEvents?.[tick]?.castAmmo }, s))
            ) {
                valid = false;
                reason = `Ability unavailable at tick ${tick}: ${abils[ability]?.title ?? ability}`;
            }
            if (ability) {
                if (input.stayInBurst && focus && abils[ability].mainStyle !== focus)
                    pendingDetour = {
                        tick,
                        before: Object.fromEntries(
                            (stackKeys[abils[ability].mainStyle] ?? []).map((k) => [k, s[k] ?? 0])
                        )
                    };
                remember({ ability }, s);
                next = tick + duration(ability, s);
            }
            return;
        }
        const updated = burstStyle(s, focus);
        if (updated !== focus) detoured = false;
        focus = updated;
        const preferred = genes[decision++];
        const duringPause = (choice: Choice) =>
            !state?.pauseTicksRemaining ||
            !choice.ability ||
            abils[choice.ability].abilityClassification === 'self cast';
        const legal = choices.filter(
            (choice) =>
                canUse(choice, s, timers, allowed) && policy(choice, s) && duringPause(choice)
        );
        const chosen =
            preferred &&
            canUse(preferred, s, timers, allowed) &&
            policy(preferred, s) &&
            duringPause(preferred)
                ? preferred
                : legal.length
                  ? legal[Math.floor(random() * legal.length)]
                  : { ability: null };
        output.push(chosen);
        remember(chosen, s);
        if (!chosen.ability) {
            next = tick + 1;
            return;
        }
        rot.abilityBar[tick] = chosen.ability;
        if (chosen.ammo != null) {
            rot.tickEvents ??= Array(300).fill(null);
            rot.tickEvents[tick] = { ...rot.tickEvents[tick], castAmmo: chosen.ammo };
        }
        next = tick + duration(chosen.ability, s);
    };
    let result = calculateRotationDamageCore(settings, rotation, input.end, select);
    if (generate) {
        next = input.start;
        focus = undefined;
        detoured = false;
        const replay = (tick: number, s: any, timers: any, rot?: RotationInput) => {
            checkDetour(tick, s);
            if (!rot || tick < input.start || tick >= input.end) return;
            const key = rot.abilityBar[tick];
            if (!key) return;
            const updated = burstStyle(s, focus);
            if (updated !== focus) detoured = false;
            focus = updated;
            if (
                tick < next ||
                !canUse(
                    { ability: key, ammo: rot.tickEvents?.[tick]?.castAmmo },
                    s,
                    timers,
                    allowed
                ) ||
                !policy({ ability: key, ammo: rot.tickEvents?.[tick]?.castAmmo }, s)
            ) {
                valid = false;
                reason = `Unavailable cast at tick ${tick}`;
            }
            if (input.stayInBurst && focus && abils[key].mainStyle !== focus)
                pendingDetour = {
                    tick,
                    before: Object.fromEntries(
                        (stackKeys[abils[key].mainStyle] ?? []).map((k) => [k, s[k] ?? 0])
                    )
                };
            remember({ ability: key }, s);
            next = tick + duration(key, s);
        };
        result = calculateRotationDamageCore(settings, rotation, input.end, replay);
    }
    if (
        !generate &&
        (rotation.stalledAbilities.slice(input.start, input.end).some(Boolean) ||
            rotation.releasedAbilities?.slice(input.start, input.end).some(Boolean))
    ) {
        valid = false;
        reason = 'Manual stalls/releases are not generated by this search.';
    }
    const score = scoreImpacts(
        input.scope === 'all'
            ? (result.impactDamagePerTick ?? [])
            : (result.mainImpactDamagePerTick ?? []),
        input
    );
    const impacts =
        input.scope === 'all'
            ? (result.impactDamagePerTick ?? [])
            : (result.mainImpactDamagePerTick ?? []);
    const phaseOutcomes = (input.phaseGoals ?? []).map((phase) => {
        const outcome = scoreImpacts(impacts, {
            start: phase.start,
            end: phase.end,
            goal: phase.damage
        });
        return {
            name: phase.name,
            damage: outcome.damage,
            goal: phase.damage,
            reached: outcome.reached === null ? null : outcome.reached + phase.start - input.start
        };
    });
    const phaseShortfall = phaseOutcomes.reduce(
        (sum, phase) => sum + Math.max(0, phase.goal - phase.damage) / phase.goal,
        0
    );
    if (phaseShortfall > 0) score.reached = null;
    else if (score.reached !== null)
        score.reached = Math.max(score.reached, ...phaseOutcomes.map((p) => p.reached ?? 0));
    return {
        rotation,
        genes: output,
        ...score,
        phaseOutcomes,
        phaseShortfall,
        casts: rotation.abilityBar.slice(input.start, input.end).filter(Boolean).length,
        valid,
        reason
    };
}

export async function searchRotations(
    input: PlannerInput,
    progress: (data: any) => void = () => {},
    stopped = () => false
) {
    validatePlanner(input);
    const random = randomSource(input.seed),
        started = performance.now();
    const baseline = evaluatePlan(input, [], input.seed, false);
    const population: Plan[] = [];
    let best: Plan | undefined = baseline.valid ? baseline : undefined;
    let trials = 0;
    const rejected: Record<string, number> = {};
    const seedGenes = input.rotation.abilityBar
        .slice(input.start, input.end)
        .flatMap((ability, i) =>
            ability
                ? [{ ability, ammo: input.rotation.tickEvents?.[input.start + i]?.castAmmo }]
                : []
        );
    const setups = input.abilities.filter(
        (key) => abils[key].abilityClassification === 'self cast'
    );
    let lastReport = 0;
    for (
        ;
        trials < input.iterations &&
        performance.now() - started < input.seconds * 1000 &&
        !stopped();
        trials++
    ) {
        let genes: Choice[] = [];
        if (trials === 0) genes = seedGenes;
        else if (trials <= setups.length) genes = [{ ability: setups[trials - 1] }];
        else if (population.length && random() > 0.2) {
            const parent = population[Math.floor(random() * population.length)];
            genes = parent.genes.map((c) => ({ ...c }));
            const index = Math.floor(random() * Math.max(1, genes.length));
            if (random() < 0.25 && population.length > 1)
                genes.splice(
                    index,
                    genes.length - index,
                    ...population[Math.floor(random() * population.length)].genes.slice(index)
                );
            else {
                const count =
                    1 + Math.floor(random() * Math.max(1, Math.ceil(genes.length * 0.25)));
                for (let j = 0; j < count; j++) {
                    const pos = (index + j) % Math.max(1, genes.length);
                    const ability =
                        random() < 0.08
                            ? null
                            : input.abilities[Math.floor(random() * input.abilities.length)];
                    genes[pos] = {
                        ability,
                        ...(ability && abils[ability].mainStyle === 'ranged' && input.ammo.length
                            ? { ammo: input.ammo[Math.floor(random() * input.ammo.length)] }
                            : {})
                    };
                }
            }
        }
        const candidate = evaluatePlan(input, genes, input.seed + trials + 1);
        if (!candidate.valid)
            rejected[candidate.reason ?? 'Unavailable cast'] =
                (rejected[candidate.reason ?? 'Unavailable cast'] ?? 0) + 1;
        if (candidate.valid) {
            if (!best || comparePlans(candidate, best, input.objective) < 0) best = candidate;
            const signature = JSON.stringify(candidate.genes);
            if (!population.some((p) => JSON.stringify(p.genes) === signature))
                population.push(candidate);
            population.sort((a, b) => comparePlans(a, b, input.objective));
            population.splice(12);
        }
        if (performance.now() - lastReport > 500 || trials === 0) {
            progress({
                best,
                baseline,
                rejected,
                trials: trials + 1,
                elapsed: (performance.now() - started) / 1000
            });
            lastReport = performance.now();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    return { best, baseline, rejected, trials, elapsed: (performance.now() - started) / 1000 };
}
