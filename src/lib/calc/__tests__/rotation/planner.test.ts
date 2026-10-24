import { it, expect } from 'vitest';
import { ARMOUR } from '$lib/data/armour';
import { ABILITIES } from '$lib/data/abilities';
import { SETTINGS } from '../../settings_rb';
import { createMeleeSettings, createRotationFromAbilities } from '../test-helpers';
import {
    evaluatePlan,
    searchRotations,
    requiredAdrenaline,
    scoreImpacts,
    comparePlans,
    allowsBurstChoice,
    burstStyle,
    type PlannerInput
} from '../../planner/planner';
function input(): PlannerInput {
    return {
        settings: createMeleeSettings({
            [SETTINGS.ADRENALINE]: 100,
            [SETTINGS.BLOODLUST_STACKS]: 0
        }),
        rotation: { ...createRotationFromAbilities([], 60), tickEvents: Array(60).fill(null) },
        abilities: [ABILITIES.MELEE_AUTO, ABILITIES.BERSERK],
        ammo: [],
        start: 0,
        end: 30,
        objective: 'damage',
        goal: 100000,
        scope: 'all',
        iterations: 30,
        seconds: 20,
        seed: 123
    };
}
it('extends a time-to-target fight beyond its initial horizon and the old 300-tick bar', async () => {
    const config = input();
    config.abilities = [ABILITIES.MELEE_AUTO];
    config.objective = 'time';
    config.untilTarget = true;
    config.end = 150;
    config.goal = evaluatePlan({...config,end:300}, [], 1).damage * 1.2;
    config.iterations = 9;
    config.seconds = 20;
    const result = await searchRotations(config);
    expect(result.end).toBeGreaterThan(300);
    expect(result.best?.reached).not.toBeNull();
    expect(result.best!.damage).toBeGreaterThanOrEqual(config.goal);
    expect(result.best!.rotation.abilityBar.length).toBeGreaterThan(300);
    expect(config.end).toBe(150);
});
it('scores landing ticks only, excluding delayed damage after the deadline and setup damage', () => {
    expect(scoreImpacts([500, 1, 2, 3, 999], { start: 1, end: 4, goal: 3 })).toEqual({
        damage: 6,
        reached: 1,
        curve: [1, 3, 6]
    });
});
it('ranks time-to-target ahead of higher damage delivered later', () => {
    const a: any = { valid: true, damage: 100, reached: 3, casts: 3 };
    const b: any = { valid: true, damage: 200, reached: 4, casts: 3 };
    expect(comparePlans(a, b, 'time')).toBeLessThan(0);
    expect(comparePlans(a, b, 'damage')).toBeGreaterThan(0);
});
it('does not use refunds to fund an ultimate and recognises stack-driven costs', () => {
    expect(
        requiredAdrenaline(ABILITIES.BERSERK, {
            [SETTINGS.VIGOUR]: true,
            [SETTINGS.CONSERVATION_OF_ENERGY]: true
        })
    ).toBe(100);
    expect(requiredAdrenaline(ABILITIES.FINGER_OF_DEATH, { [SETTINGS.NECROSIS_STACKS]: 6 })).toBe(
        0
    );
    expect(requiredAdrenaline(ABILITIES.DEADSHOT, { [SETTINGS.DEATHSPORE_BUFF]: true })).toBe(0);
});
it('values setup that loses early damage but wins over the whole window', () => {
    const config = input();
    const direct = evaluatePlan(config, Array(30).fill({ ability: ABILITIES.MELEE_AUTO }), 1);
    const setup = evaluatePlan(
        config,
        [{ ability: ABILITIES.BERSERK }, ...Array(30).fill({ ability: ABILITIES.MELEE_AUTO })],
        1
    );
    expect(setup.valid).toBe(true);
    expect(setup.curve[2]).toBeLessThan(direct.curve[2]);
    expect(setup.damage).toBeGreaterThan(direct.damage);
});
it('searches complete sequences, returns a valid result and preserves fixed prefix conditions', async () => {
    const config = input();
    config.start = 3;
    config.rotation.abilityBar[0] = ABILITIES.MELEE_AUTO;
    config.rotation.tickEvents![12] = { phase: 'Next', accuracy: 70 };
    const before = structuredClone(config);
    const result = await searchRotations(config);
    expect(result.best?.valid).toBe(true);
    expect(result.best!.damage).toBeGreaterThan(0);
    expect(result.best!.rotation.abilityBar[0]).toBe(ABILITIES.MELEE_AUTO);
    expect(result.best!.rotation.tickEvents![12]).toEqual({ phase: 'Next', accuracy: 70 });
    expect(config).toEqual(before);
});
it('rejects a baseline with an unaffordable cast', () => {
    const config = input();
    config.settings[SETTINGS.ADRENALINE] = 0;
    config.rotation.abilityBar[0] = ABILITIES.BERSERK;
    expect(evaluatePlan(config, [], 1, false).valid).toBe(false);
});

it('tracks actual impacts separately from cast-phase reporting', () => {
    const config = input();
    config.rotation.abilityBar[0] = ABILITIES.MELEE_AUTO;
    config.rotation.tickEvents![1] = { phase: 'Damage phase' };
    const scored = evaluatePlan(config, [], 1, false);
    expect(scored.curve[0]).toBe(0);
    expect(scored.curve[2]).toBeGreaterThan(0);
});
it('obeys stop requests and keeps the completed baseline', async () => {
    const config = input();
    const out = await searchRotations(
        config,
        () => {},
        () => true
    );
    expect(out.trials).toBe(0);
    expect(out.baseline).toBeDefined();
});

it('keeps ultimates in their own style, permitting only one basic detour before returning', () => {
    const s: any = {
        ...input().settings,
        [SETTINGS.BERSERK]: true,
        [SETTINGS.ICY_CHILL_STACKS]: 0,
        [SETTINGS.RANGED_AMMO_SLOT]: ARMOUR.WEN_ARROWS
    };
    expect(burstStyle(s)).toBe('melee');
    expect(allowsBurstChoice(ABILITIES.DEATHS_SWIFTNESS, s, 'melee', false, true)).toBe(false);
    expect(allowsBurstChoice(ABILITIES.PIERCING_SHOT, s, 'melee', false, false)).toBe(false);
    expect(allowsBurstChoice(ABILITIES.PIERCING_SHOT, s, 'melee', false, true)).toBe(true);
    expect(allowsBurstChoice(ABILITIES.PIERCING_SHOT, s, 'melee', true, true)).toBe(false);
    expect(allowsBurstChoice(ABILITIES.MELEE_AUTO, s, 'melee', true, true)).toBe(true);
    expect(burstStyle({ [SETTINGS.BERSERK]: false }, 'melee')).toBeUndefined();
});
it('prioritises phase requirements over dumping more damage into an earlier phase', () => {
    const a: any = { valid: true, damage: 100, phaseShortfall: 0, reached: 10, casts: 4 };
    const b: any = { valid: true, damage: 200, phaseShortfall: 0.5, reached: 4, casts: 4 };
    expect(comparePlans(a, b, 'damage')).toBeLessThan(0);
    expect(comparePlans(a, b, 'time')).toBeLessThan(0);
});
it('reports an unmet phase goal even if total damage reaches the global goal', () => {
    const config = input();
    config.goal = 1;
    config.phaseGoals = [{ name: 'First phase', start: 0, end: 1, damage: 100 }];
    const result = evaluatePlan(config, Array(30).fill({ ability: ABILITIES.MELEE_AUTO }), 1);
    expect(result.damage).toBeGreaterThan(1);
    expect(result.reached).toBeNull();
    expect(result.phaseShortfall).toBe(1);
});

it('a brid sequence returns to Berserk after a Wen stack-building detour', () => {
    const config = input();
    config.stayInBurst = true;
    config.stackDetours = true;
    config.settings[SETTINGS.RANGED_AMMO_SLOT] = ARMOUR.WEN_ARROWS;
    config.settings[SETTINGS.ICY_CHILL_STACKS] = 0;
    config.abilities.push(ABILITIES.PIERCING_SHOT);
    const result = evaluatePlan(
        config,
        [
            { ability: ABILITIES.BERSERK },
            { ability: ABILITIES.PIERCING_SHOT, ammo: ARMOUR.WEN_ARROWS },
            { ability: ABILITIES.PIERCING_SHOT },
            ...Array(30).fill({ ability: ABILITIES.MELEE_AUTO })
        ],
        3
    );
    expect(result.valid).toBe(true);
    expect(result.rotation.abilityBar[3]).toBe(ABILITIES.PIERCING_SHOT);
    expect(result.rotation.abilityBar[6]).toBe(ABILITIES.MELEE_AUTO);
});
it('allows a self-buff to prepare during phase downtime', () => {
    const config = input();
    config.rotation.tickEvents![0] = { phase: 'Prepare', downtime: 3 };
    const result = evaluatePlan(
        config,
        [{ ability: ABILITIES.BERSERK }, ...Array(30).fill({ ability: ABILITIES.MELEE_AUTO })],
        1
    );
    expect(result.rotation.abilityBar[0]).toBe(ABILITIES.BERSERK);
    expect(result.valid).toBe(true);
    expect(result.curve[2]).toBe(0);
});
