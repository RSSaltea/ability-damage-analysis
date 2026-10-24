import { it, expect } from 'vitest';
import { ABILITIES } from '$lib/data/abilities';
import { equipment } from '$lib/data/equipment';
import { SETTINGS } from '../../settings_rb';
import { addPreparation, damageShare } from '../../planner/encounter';
import { evaluatePlan, type PlannerInput } from '../../planner/planner';
import { calculateRotationDamageCore } from '../../rotation_builder/rotation-damage-calculator';
import { normalizeTickEvent } from '../../rotation_builder/tickEvents';
import { CONSUMABLES } from '$lib/special/abilities';
import { createMeleeSettings, createRotationFromAbilities } from '../test-helpers';

function setup(): PlannerInput {
    return {
        settings: createMeleeSettings({
            [SETTINGS.ADRENALINE]: 100,
            [SETTINGS.BLOODLUST_STACKS]: 0
        }),
        rotation: {
            ...createRotationFromAbilities([], 60),
            targetCounts: Array(60).fill(null),
            tickEvents: Array(60).fill(null)
        },
        abilities: [ABILITIES.MELEE_AUTO, ABILITIES.BERSERK],
        ammo: [],
        start: 0,
        end: 40,
        objective: 'damage',
        goal: 100000,
        scope: 'all',
        iterations: 10,
        seconds: 10,
        seed: 1
    };
}
it('stops charging at the Wars exit instead of granting crystal pulses during travel', () => {
    const c = setup();
    addPreparation(c.rotation, [], 3, 9, 0);
    c.rotation.extraActionBar[0] = [CONSUMABLES.ADRENALINE_CRYSTAL];
    c.settings[SETTINGS.ADRENALINE] = 0;
    const values: number[] = [];
    calculateRotationDamageCore(c.settings, c.rotation, 12, (tick, s) => {
        values[tick] = s[SETTINGS.ADRENALINE];
    });
    expect(values[3]).toBeGreaterThan(0);
    expect(values[10]).toBe(values[3]);
});
it('splits team damage between dealers without counting zero-damage extras', () => {
    expect(damageShare(2, 2, 0)).toBe(0.5);
    expect(damageShare(2, 2, 50)).toBeCloseTo(1 / 3);
    expect(() => damageShare(0, 2, 0)).toThrow();
});
it('aligns fight sections and scripted actions after Wars, travel and dummy preparation', () => {
    const c = setup();
    c.rotation.extraActionBar[24] = ['adrenaline renewal'];
    const p = addPreparation(
        c.rotation,
        [
            { tick: 0, name: 'Wars' },
            { tick: 22, name: 'Phase 1-3' },
            { tick: 45, name: 'Heart' }
        ],
        12,
        8,
        6
    );
    expect(p.fight).toBe(26);
    expect(p.phases.map((p) => [p.name, p.tick])).toEqual([
        ['Wars', 0],
        ['Travel', 12],
        ['Prebuild', 20],
        ['Phase 1-3', 26],
        ['Heart', 49]
    ]);
    expect(c.rotation.extraActionBar[28]).toEqual(['adrenaline renewal']);
    expect(normalizeTickEvent(c.rotation.tickEvents![0])?.encounterStage).toBe('dummy');
});
it('dummy hits build resources but never damage the boss; travel has no casts and replay agrees', () => {
    const c = setup();
    addPreparation(c.rotation, [], 9, 6, 3);
    c.rotation.tickEvents![18] = { encounterStage: 'fight', target: 'none', accuracy: 100 };
    c.settings[SETTINGS.BOSS_PATTERN_START] = 18;
    c.fightStart = 18;
    c.preparation = { wars: 9, travel: 6, dummy: 3 };
    const result = evaluatePlan(c, Array(40).fill({ ability: ABILITIES.MELEE_AUTO }), 1);
    expect(result.valid).toBe(true);
    expect(result.rotation.abilityBar.slice(9, 15).every((a) => a === null)).toBe(true);
    expect(result.curve.slice(0, 18).every((n) => n === 0)).toBe(true);
    let stacks = 0;
    const replay = calculateRotationDamageCore(c.settings, result.rotation, c.end, (tick, s) => {
        if (tick === 9) stacks = s[SETTINGS.BLOODLUST_STACKS];
    });
    expect(stacks).toBeGreaterThan(0);
    expect(replay.impactDamagePerTick!.slice(18, 40).reduce((a, b) => a + b, 0)).toBe(
        result.damage
    );
});
it('separated AoE requires both the assigned role and a halberd-range equipped weapon', () => {
    const c = setup();
    const scythe = Object.values(equipment).find((e) => /noxious scythe/i.test(e.name))!;
    expect(scythe).toBeTruthy();
    c.settings[SETTINGS.MELEE_TH] = scythe.id;
    c.settings[SETTINGS.BOSS_PRESET] = 'lady karmina ghrazi';
    c.settings[SETTINGS.GHRAZI_DISTANCE] = 3;
    c.rotation.abilityBar[0] = ABILITIES.HURRICANE;
    c.rotation.targetCounts[0] = 2;
    c.rotation.tickEvents![0] = { ghraziAoeRole: true };
    const owner = calculateRotationDamageCore(c.settings, c.rotation, 12);
    c.rotation.tickEvents![0] = { ghraziAoeRole: false };
    const partner = calculateRotationDamageCore(c.settings, c.rotation, 12);
    expect(Object.values(owner.secondaryDamage ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(
        0
    );
    expect(Object.values(partner.secondaryDamage ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
});
it('records distance changes with paid movement time and reproduces their damage on replay', () => {
    const c = setup();
    c.positioning = { distances: [2, 3], meleeOwner: true, moveTicks: 3 };
    c.settings[SETTINGS.GHRAZI_DISTANCE] = 2;
    c.rotation.tickEvents![0] = { ghraziDistance: 2, ghraziAoeRole: true };
    const result = evaluatePlan(
        c,
        Array(40).fill({ ability: ABILITIES.MELEE_AUTO, distance: 3 }),
        1
    );
    expect(result.rotation.tickEvents![0]?.ghraziDistance).toBe(3);
    expect(result.rotation.abilityBar.slice(0, 3)).toEqual([null, null, null]);
    const replay = calculateRotationDamageCore(c.settings, result.rotation, c.end);
    expect(replay.impactDamagePerTick!.slice(0, c.end).reduce((a, b) => a + b, 0)).toBe(
        result.damage
    );
});
