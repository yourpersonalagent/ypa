import { Fragment } from 'react';
import { useRegisterList } from '../useRegisterList.js';
import { registers } from '../keys.js';

/**
 * Renders the workflow editor HUD button row from the `hudButtons` register.
 * Inserts `<div class="hud-sep"/>` between entries that have different
 * `hudGroup` values so modules can declare their own visual groups without
 * FullLayout needing to know the group structure.
 */
export function WorkflowHudSlot() {
  const buttons = useRegisterList(registers.hudButtons);

  return (
    <>
      {buttons.map((btn, i) => {
        const showSep = i > 0 && btn.hudGroup !== buttons[i - 1].hudGroup;
        if (btn.component) {
          const Cmp = btn.component;
          return (
            <Fragment key={btn.id}>
              {showSep && <div className="hud-sep" />}
              <Cmp />
            </Fragment>
          );
        }
        return (
          <Fragment key={btn.id}>
            {showSep && <div className="hud-sep" />}
            <button
              id={btn.domId}
              className={`hud-btn${btn.className ? ` ${btn.className}` : ''}`}
              title={btn.title}
              onClick={btn.onClick}
            >
              {btn.icon}
            </button>
          </Fragment>
        );
      })}
    </>
  );
}
