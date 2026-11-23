# Spec Delta

## Purpose

What the release of the dream owner role must carry so that the next owner continues the replay where the previous one stopped.

## ADDED Requirements

### Requirement: A release names the last covered window

The release of the dream owner role SHALL name the last window the releasing device covered, or state that it covered none. A device that takes the role by force, without a release, SHALL continue from the newest covered window it holds and SHALL report that the previous owner's last windows may not have arrived.

#### Scenario: A release with coverage

- **WHEN** the current owner releases the role after covering windows
- **THEN** the release record names the last covered window

#### Scenario: A forced takeover

- **WHEN** a device takes the role by force while the previous owner is unreachable
- **THEN** it continues from the newest covered window it holds and its status says the previous owner's last windows may be missing
