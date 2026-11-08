import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

import type { ViewSnapshot } from '../types.ts';
import { caseState } from '../view-model.ts';

import { useAnchoredCase } from './use-anchored-case.ts';

export function useRunNavigation(snapshot: ViewSnapshot, wide: boolean, onExit: () => void) {
  const { report, entries, current } = snapshot;

  const scroll = useRef<ScrollBoxRenderable>(null);
  const list = useRef<ScrollBoxRenderable>(null);
  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // Focus names a section, not a position: an inserted raw-judgment section must not shift it.
  const [focusId, setFocusId] = useState('scenario');

  const [help, setHelp] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const results = new Map(report.results.map((item) => [item.key, item] as const));
  const entry = entries[selected];
  const caseKey = help ? undefined : entry?.key;
  const incomingResult = caseKey ? results.get(caseKey) : undefined;
  const bundle = entry ? snapshot.bundles?.get(entry.key) : undefined;
  const { result, sections } = useAnchoredCase({ entry, caseKey, incomingResult, bundle, scroll });

  const focus = Math.max(
    0,
    sections.findIndex((section) => section.id === focusId),
  );

  const states = entries.map((item) =>
    caseState(item.key, results.get(item.key), current, snapshot.finished),
  );
  const state = caseKey ? caseState(caseKey, result, current, snapshot.finished) : 'pending';
  const phase =
    !snapshot.finished && entry && current?.key === entry.key ? current.phase : undefined;

  const isClosed = (id: string, initial: boolean): boolean =>
    closed[`${entry?.key}/${id}`] ?? initial;

  useEffect(() => {
    if (!follow || !current) return;
    const index = entries.findIndex((item) => item.key === current.key);
    if (index >= 0) {
      setSelected(index);
      setFocusId('scenario');
      scroll.current?.scrollTo(0);
    }
  }, [current?.key, follow, entries]);

  useEffect(() => {
    if (snapshot.finished) setConfirmStop(false);
  }, [snapshot.finished]);

  useEffect(() => {
    if (wide) list.current?.scrollChildIntoView(`case-${selected}`);
  }, [selected, wide]);

  function toggle(index: number): void {
    const section = sections[index];
    if (!section) return;
    const header = scroll.current?.findDescendantById(`section-${section.id}`);
    // Keep the heading in place through the body's layout change, including resize.
    const release = header && scroll.current?.anchor(header);
    setClosed((previous) => ({
      ...previous,
      [`${entry?.key}/${section.id}`]: !isClosed(section.id, section.collapsed),
    }));
    setFocusId(section.id);
    setFollow(false);

    scroll.current?.afterLayout(() => {
      release?.();
      scroll.current?.scrollChildIntoView(`section-${section.id}`);
    });
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      onExit();
      return;
    }

    if (confirmStop) {
      key.preventDefault();
      if (key.name === 'y') onExit();
      else if (key.name === 'n' || key.name === 'escape') setConfirmStop(false);
      return;
    }

    if (key.name === 'q') {
      snapshot.finished ? onExit() : setConfirmStop(true);
      return;
    }

    if (key.name === '?' || (key.name === 'escape' && help)) {
      setHelp(!help);
      setFollow(false);
      scroll.current?.scrollTo(0);
      return;
    }

    if (help) return;
    if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) setFollow(false);
    if (key.name === '[' || key.name === ']') {
      setFollow(false);
      setSelected((index) =>
        Math.max(0, Math.min(entries.length - 1, index + (key.name === ']' ? 1 : -1))),
      );
      setFocusId('scenario');
      scroll.current?.scrollTo(0);
    } else if (key.name === 'tab') {
      key.preventDefault();
      setFollow(false);
      const next =
        sections[(focus + (key.shift ? -1 : 1) + sections.length) % Math.max(1, sections.length)];
      if (!next) return;
      setFocusId(next.id);
      scroll.current?.scrollChildIntoView(`section-${next.id}`);
    } else if (key.name === 'return') {
      key.preventDefault();
      toggle(focus);
    } else if (key.name === 's' || key.name === 'p')
      toggle(
        sections.findIndex((section) => section.id === (key.name === 's' ? 'skill' : 'input')),
      );
    else if (key.name === 'f') setFollow(true);
  });

  const quit: [string, string] = ['q', snapshot.finished ? 'close' : 'stop'];
  const keys: [string, string][] = help
    ? [['? Esc', 'close help'], quit]
    : wide
      ? [
          ['[/]', 'case'],
          ['Tab', 'section'],
          ['Enter', 'toggle'],
          ['s', 'skill'],
          ['p', 'prompt'],
          ['↑↓ PgUp PgDn', 'scroll'],
          ...(!snapshot.finished && !follow ? [['f', 'follow live'] as [string, string]] : []),
          ['?', 'help'],
          quit,
        ]
      : [
          ['[/]', 'case'],
          ['Tab', 'section'],
          ['Enter', 'toggle'],
          ['s', 'skill'],
          ['p', 'prompt'],
          ['?', 'help'],
          quit,
        ];

  const followNote = snapshot.finished
    ? undefined
    : follow
      ? 'following the live case'
      : 'f to follow the live case';

  return {
    caseList: { entries, states, selected, listRef: list },
    readingPane: { scroll, entry, result, sections, focus, isClosed, state, phase, followNote },
    help,
    confirmStop,
    keys,
  };
}
