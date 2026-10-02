import { describe, expect, it } from 'vitest';
import {
  arbitratePointer,
  shouldAnnotationAccept,
  shouldGestureLayerPassThrough,
  PALM_CONTACT_AREA_PX2,
  type ArbitrationInput,
} from '@/lib/stand/input-arbitration';

const base: ArbitrationInput = { editMode: true, pointerType: 'pen' };

describe('arbitratePointer', () => {
  describe('annotate mode off', () => {
    it('sends a pen to navigation so nothing draws on the score', () => {
      const d = arbitratePointer({ editMode: false, pointerType: 'pen' });
      expect(d.consumer).toBe('navigation');
      expect(d.reason).toBe('annotate-mode-off');
    });

    it('sends touch to navigation', () => {
      expect(arbitratePointer({ editMode: false, pointerType: 'touch' }).consumer).toBe(
        'navigation',
      );
    });

    it('sends mouse to navigation', () => {
      expect(arbitratePointer({ editMode: false, pointerType: 'mouse' }).consumer).toBe(
        'navigation',
      );
    });
  });

  describe('annotate mode on — drawing devices', () => {
    it('gives a pen to the annotation layer', () => {
      const d = arbitratePointer({ ...base, pointerType: 'pen' });
      expect(d.consumer).toBe('annotation');
      expect(d.reason).toBe('pen-draws');
    });

    it('gives a mouse to the annotation layer', () => {
      const d = arbitratePointer({ editMode: true, pointerType: 'mouse' });
      expect(d.consumer).toBe('annotation');
      expect(d.reason).toBe('mouse-draws');
    });

    it('does not swallow pen input in the gesture layer', () => {
      expect(shouldGestureLayerPassThrough(arbitratePointer(base))).toBe(true);
      expect(shouldAnnotationAccept(arbitratePointer(base))).toBe(true);
    });
  });

  describe('annotate mode on — touch', () => {
    it('sends touch to navigation when no pen is in use', () => {
      const d = arbitratePointer({ editMode: true, pointerType: 'touch' });
      expect(d.consumer).toBe('navigation');
      expect(d.reason).toBe('touch-navigates');
    });

    it('keeps sending touch to navigation while a pen is active', () => {
      // The Piascore interaction: pencil writes, hand turns the page.
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        penActive: true,
      });
      expect(d.consumer).toBe('navigation');
      expect(d.reason).toBe('pen-active-touch-navigates');
    });

    it('never sends touch to the annotation layer, even small and single', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        contactArea: 10,
        activeTouchPoints: 1,
      });
      expect(d.consumer).not.toBe('annotation');
    });
  });

  describe('palm rejection', () => {
    it('ignores a large touch contact', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        contactArea: PALM_CONTACT_AREA_PX2 + 1,
      });
      expect(d.consumer).toBe('ignored');
      expect(d.reason).toBe('palm-rejected');
    });

    it('accepts the boundary area as a fingertip', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        contactArea: PALM_CONTACT_AREA_PX2,
      });
      expect(d.consumer).toBe('navigation');
    });

    it('ignores multi-touch', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        activeTouchPoints: 2,
      });
      expect(d.consumer).toBe('ignored');
      expect(d.reason).toBe('multitouch-rejected');
    });

    it('accepts a single small touch', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        activeTouchPoints: 1,
        contactArea: 50,
      });
      expect(d.consumer).toBe('navigation');
    });

    it('checks palm before pen-active so a resting hand is dropped, not a page turn', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        penActive: true,
        contactArea: PALM_CONTACT_AREA_PX2 + 500,
      });
      expect(d.consumer).toBe('ignored');
    });
  });

  describe('unknown devices', () => {
    it('navigates rather than risking ink from an unidentifiable device', () => {
      const d = arbitratePointer({ editMode: true, pointerType: '' });
      expect(d.consumer).toBe('navigation');
      expect(d.reason).toBe('unknown-device-navigates');
    });

    it('handles a future pointerType value safely', () => {
      const d = arbitratePointer({ editMode: true, pointerType: 'stylus-9000' });
      expect(d.consumer).toBe('navigation');
    });
  });

  describe('ignoreTouch setting', () => {
    it('ignores touch when the user has disabled it', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'touch',
        ignoreTouch: true,
      });
      expect(d.consumer).toBe('ignored');
      expect(d.reason).toBe('touch-ignored-by-setting');
    });

    it('does not affect pen input when ignoreTouch is set', () => {
      const d = arbitratePointer({
        editMode: true,
        pointerType: 'pen',
        ignoreTouch: true,
      });
      expect(d.consumer).toBe('annotation');
    });
  });

  describe('layer ownership', () => {
    it('never lets the gesture layer consume a pointer meant for annotation', () => {
      // The invariant that matters: if the annotation layer owns the pointer,
      // the gesture overlay must let it through. The reverse is the bug that
      // made stylus writing impossible.
      const cases: ArbitrationInput[] = [
        { editMode: true, pointerType: 'pen' },
        { editMode: true, pointerType: 'mouse' },
        { editMode: true, pointerType: 'touch' },
        { editMode: true, pointerType: 'touch', penActive: true },
        { editMode: false, pointerType: 'pen' },
        { editMode: true, pointerType: 'touch', contactArea: 5000 },
      ];

      for (const c of cases) {
        const d = arbitratePointer(c);
        if (shouldAnnotationAccept(d)) {
          expect(
            shouldGestureLayerPassThrough(d),
            `gesture layer must pass through when annotation owns the pointer: ${JSON.stringify(c)}`,
          ).toBe(true);
        }
      }
    });

    it('a navigation pointer is never also accepted by the annotation layer', () => {
      const cases: ArbitrationInput[] = [
        { editMode: true, pointerType: 'touch' },
        { editMode: true, pointerType: 'touch', penActive: true },
        { editMode: false, pointerType: 'pen' },
        { editMode: false, pointerType: 'mouse' },
        { editMode: true, pointerType: 'touch', contactArea: 5000 },
        { editMode: true, pointerType: '' },
      ];

      for (const c of cases) {
        const d = arbitratePointer(c);
        if (d.consumer === 'navigation') {
          expect(
            shouldAnnotationAccept(d),
            `annotation must not accept a navigation pointer: ${JSON.stringify(c)}`,
          ).toBe(false);
        }
      }
    });
  });
});
