# Canonfig v6.1.1

Synchronization and enrollment now record explicit lifecycle transitions, and
first-time followers can enroll again after a Source restart discards their
pending enrollment.

This build requires fresh Canonfig state. It refuses earlier databases, including
6.1 state, without changing their schema or data. Move
`~/.canonfig/state.sqlite` aside and set the machine up again. There is no
in-place state conversion.
