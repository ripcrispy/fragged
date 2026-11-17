# Polls

Add a poll to a forum thread. The poll sits at the top of the thread, above the posts, and members vote without
leaving the page. Everything works without JavaScript.

- **Adding a poll:** the thread's author sees **Add a poll to this thread** at the top of their thread
  (`/m/polls/new?thread=<id>`). Moderators of the forum and members with `polls.manage` can add one to any thread.
  One poll per thread; locked threads can't get a new poll.
- **Options:** a question and 2–10 answers (one per line); how many answers each member may pick (1 = single
  choice); when results are shown (**always**, **after voting** or **when the poll closes**); an optional closing
  time; whether members can change their vote; and whether to show who voted for each answer (members see this
  before voting).
- **Voting:** one ballot per member, safe against double submits. If changes are allowed, members can change or
  remove their vote until the poll closes. Members who haven't voted see the results so far behind
  **See the results so far** (when results are public).
- **Control:** the poll's creator, the forum's moderators (`mod.threads`) and `polls.manage` can close, reopen and
  delete it. Actions by someone other than the creator are recorded in the audit log (`polls.close`,
  `polls.reopen`, `polls.delete`). The creator and moderators always see the results.

| Permission | Default | Lets you |
| --- | --- | --- |
| `polls.view` | guests, members | see polls and their results |
| `polls.vote` | members | vote |
| `polls.create` | members | add a poll to your own threads |
| `polls.manage` | administrators | close, reopen and delete any poll; add polls to any thread |

**Limits:** questions up to 200 characters, answers up to 120, 60 votes per member per hour.

**Privacy:** votes and polls are part of each member's data download (Settings › Your data). Erasing add-on data
keeps the vote in the totals but removes the link to the member, so results stay correct. Deleting a thread
deletes its poll.

**Data:** `mod_polls_polls`, `mod_polls_options`, `mod_polls_ballots`, `mod_polls_choices`.
