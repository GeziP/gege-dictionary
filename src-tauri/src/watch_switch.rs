//! The switch behind "划词即查": on or off, and the "暂停 30 分钟" that can be running on it.
//!
//! The clipboard watcher reads it; the tray menu and the settings page change it. A pause must
//! not outlive a choice the user makes while it runs: pausing and then switching the watcher
//! off by hand leaves it off when the half hour is over, and a second pause lasts its own full
//! half hour instead of ending together with the first.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

struct Changes {
    /// How many times the switch has been changed. A pause ends itself only while it is the
    /// latest change.
    count: u64,
    /// Whether the watcher is off because of a pause, rather than because the user turned it off.
    paused: bool,
}

#[derive(Clone)]
pub struct WatchSwitch {
    enabled: Arc<AtomicBool>,
    changes: Arc<Mutex<Changes>>,
}

impl WatchSwitch {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(enabled)),
            changes: Arc::new(Mutex::new(Changes {
                count: 0,
                paused: false,
            })),
        }
    }

    /// The flag the clipboard watcher polls.
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.enabled.clone()
    }

    pub fn is_on(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    fn changes(&self) -> MutexGuard<'_, Changes> {
        // A panic elsewhere must not take the switch down with it: the counter is always valid.
        self.changes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The user flipped the switch (any pause that is running is over). Returns where it is now.
    pub fn toggle(&self) -> bool {
        let mut changes = self.changes();
        changes.count += 1;
        changes.paused = false;
        let on = !self.enabled.load(Ordering::Relaxed);
        self.enabled.store(on, Ordering::Relaxed);
        on
    }

    /// Pauses the watcher. Returns the mark that ends this pause, and no other, or `None` when
    /// there is nothing to pause because the user has turned the watcher off. Pausing during a
    /// pause starts the time over.
    pub fn pause(&self) -> Option<u64> {
        let mut changes = self.changes();
        if !changes.paused && !self.enabled.load(Ordering::Relaxed) {
            return None;
        }
        changes.count += 1;
        changes.paused = true;
        self.enabled.store(false, Ordering::Relaxed);
        Some(changes.count)
    }

    /// Ends the pause that began with `mark` by switching the watcher on again, unless the
    /// switch has been touched since (a later pause counts as touching it). Returns whether the
    /// watcher was switched on.
    pub fn end_pause(&self, mark: u64) -> bool {
        let mut changes = self.changes();
        if changes.count != mark || !changes.paused {
            return false;
        }
        changes.count += 1;
        changes.paused = false;
        self.enabled.store(true, Ordering::Relaxed);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pause_ends_by_itself_when_nobody_touches_the_switch() {
        let switch = WatchSwitch::new(true);
        let mark = switch.pause().expect("a watcher that is on can be paused");
        assert!(!switch.is_on());

        assert!(switch.end_pause(mark));
        assert!(switch.is_on());
    }

    #[test]
    fn switching_it_on_during_a_pause_ends_the_pause() {
        let switch = WatchSwitch::new(true);
        let mark = switch.pause().unwrap();

        assert!(
            switch.toggle(),
            "off because of the pause, so a flip turns it on"
        );
        assert!(switch.is_on());
        assert!(
            !switch.end_pause(mark),
            "nothing is left of the pause to end"
        );
        assert!(switch.is_on());
    }

    #[test]
    fn a_switch_the_user_turned_off_after_a_pause_is_not_turned_on_by_it() {
        let switch = WatchSwitch::new(true);
        let mark = switch.pause().unwrap();

        assert!(switch.toggle(), "on again, by hand");
        assert!(!switch.toggle(), "and off, by hand");

        assert!(
            !switch.end_pause(mark),
            "the user's choice outlasts the pause"
        );
        assert!(!switch.is_on());
    }

    #[test]
    fn a_second_pause_replaces_the_first() {
        let switch = WatchSwitch::new(true);
        let first = switch.pause().unwrap();
        let second = switch.pause().expect("pausing again starts the time over");

        assert!(
            !switch.end_pause(first),
            "the first half hour is up, the second began later"
        );
        assert!(!switch.is_on());
        assert!(switch.end_pause(second));
        assert!(switch.is_on());
    }

    #[test]
    fn a_watcher_the_user_turned_off_is_not_paused_and_so_not_turned_on_later() {
        let switch = WatchSwitch::new(false);
        assert_eq!(switch.pause(), None);

        assert!(switch.toggle());
        assert!(!switch.toggle());
        assert_eq!(switch.pause(), None);
        assert!(!switch.is_on());
    }

    #[test]
    fn an_ended_pause_cannot_end_twice() {
        let switch = WatchSwitch::new(true);
        let mark = switch.pause().unwrap();
        assert!(switch.end_pause(mark));

        assert!(!switch.toggle(), "turned off by hand");

        assert!(!switch.end_pause(mark));
        assert!(!switch.is_on());
    }

    #[test]
    fn the_clipboard_watcher_sees_every_change_through_its_flag() {
        let switch = WatchSwitch::new(false);
        let flag = switch.flag();
        assert!(!flag.load(Ordering::Relaxed));

        assert!(switch.toggle());
        assert!(flag.load(Ordering::Relaxed));
        let mark = switch.pause().unwrap();
        assert!(!flag.load(Ordering::Relaxed));
        switch.end_pause(mark);
        assert!(flag.load(Ordering::Relaxed));
        assert!(!switch.toggle());
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[test]
    fn a_copy_of_the_switch_is_the_same_switch() {
        let switch = WatchSwitch::new(true);
        let other = switch.clone();

        let mark = other.pause().unwrap();

        assert!(!switch.is_on());
        assert!(switch.end_pause(mark));
        assert!(other.is_on());
    }
}
