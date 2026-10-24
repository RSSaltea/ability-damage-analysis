import { it, expect } from 'vitest';
import { ABILITIES } from '$lib/data/abilities';
import { SETTINGS } from '../../settings_rb';
import { calculateRotationDamageCore } from '../../rotation_builder/rotation-damage-calculator';
import { createMeleeSettings, createRotationFromAbilities } from '../test-helpers';
it('consecutive casts of the same melee basic each build Bloodlust', () => {
    const rotation = createRotationFromAbilities([], 12);
    for (const tick of [0, 3, 6]) rotation.abilityBar[tick] = ABILITIES.MELEE_AUTO;
    const frames: any = {};
    calculateRotationDamageCore(
        createMeleeSettings({ [SETTINGS.BLOODLUST_STACKS]: 0 }),
        rotation,
        12,
        (tick, s) => (frames[tick] = { ...s })
    );
    expect(frames[9][SETTINGS.BLOODLUST_STACKS]).toBe(3);
});
it('consecutive casts of the same magic basic each build Blood Tithe', () => {
    const rotation = createRotationFromAbilities([], 12);
    for (const tick of [0, 3, 6]) rotation.abilityBar[tick] = ABILITIES.MAGIC_AUTO;
    const frames: any = {};
    calculateRotationDamageCore(
        createMeleeSettings({
            [SETTINGS.AUTO_CAST]: SETTINGS.AUTO_CAST_VALUES.EXSANGUINATE,
            [SETTINGS.BLOOD_TITHE]: 0
        }),
        rotation,
        12,
        (tick, s) => (frames[tick] = { ...s })
    );
    expect(frames[9][SETTINGS.BLOOD_TITHE]).toBe(3);
});
