import { PageHead } from '../components/PageHead';
import { Link } from '../lib/router';

const RULES: { id: string; title: string; body: string; examples?: string[] }[] = [
  {
    id: 'harassment',
    title: 'Don’t harass people.',
    body: 'Disagree as hard as you like with ideas. Don’t target people: no pile-ons, no repeated unwanted contact, no encouraging others to go after someone, no slurs or insults aimed at a person.',
    examples: ['Replying to every post someone makes after they’ve asked you to stop', 'Making new accounts to reach someone who blocked you'],
  },
  {
    id: 'hate',
    title: 'No hateful conduct.',
    body: 'Don’t attack, dehumanise or call for exclusion of people based on race, ethnicity, national origin, caste, religion, disability, disease, age, sex, gender identity or sexual orientation. Discussing these topics is fine; demeaning people for who they are is not.',
  },
  {
    id: 'violence',
    title: 'No threats or glorified violence.',
    body: 'No threats against anyone, including “jokes” that read as threats. Don’t celebrate or encourage violence, terrorism or self-harm. If you’re struggling, posting about it is welcome — we’ll never remove someone for asking for help.',
  },
  {
    id: 'minors',
    title: 'Zero tolerance for sexual content involving minors.',
    body: 'Any sexualised content involving anyone under 18 — real, drawn or generated — is removed immediately, the account is permanently suspended, and we report it to the relevant authorities. There are no warnings and no appeals for this rule.',
  },
  {
    id: 'intimate',
    title: 'No intimate media without consent.',
    body: 'Never share or threaten to share private sexual images or videos of someone without their clear consent, including fakes. Links to such material count too.',
  },
  {
    id: 'spam',
    title: 'No spam or manipulation.',
    body: 'Don’t post the same thing over and over, run fake or coordinated accounts, buy or sell engagement, or use automation to flood mentions and replies. Relay’s feeds are chronological, so there’s no algorithm to game — please don’t try to game people instead.',
  },
  {
    id: 'impersonation',
    title: 'Be who you say you are — or say you’re not.',
    body: 'Don’t pretend to be another person or organisation in a way that could mislead. Parody and fan accounts are fine when they say so clearly in the name or bio.',
  },
  {
    id: 'privacy',
    title: 'Don’t share people’s private information.',
    body: 'No doxxing: home addresses, private phone numbers, ID documents, financial details, or anything that would let someone be found or harmed without their consent. Encouraging others to dig this up counts too.',
  },
  {
    id: 'illegal',
    title: 'No illegal goods or services.',
    body: 'Don’t use Relay to sell, buy or arrange weapons, drugs, stolen data, counterfeit documents or other illegal goods and services, or to promote scams and fraud.',
  },
];

export default function Rules(_props: { params: Record<string, string> }) {
  return (
    <>
      <PageHead title="Community rules" back="/" />
      <article className="prose">
        <header className="prose-head">
          <p className="kicker">Relay · community rules</p>
          <h2 className="prose-title">Be someone people are glad to read.</h2>
          <p className="prose-lede">
            Relay is a shared space for writing and conversation. These rules are short on purpose: they describe what gets content
            removed or accounts suspended. Everything else is up to you — and to the tools you have for shaping your own feed.
          </p>
        </header>

        <ol className="rules-list">
          {RULES.map((r, i) => (
            <li key={r.id} id={`rule-${r.id}`} className="rule-item">
              <span className="rule-num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div>
                <h3>{r.title}</h3>
                <p>{r.body}</p>
                {r.examples && (
                  <ul className="rule-examples">
                    {r.examples.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>

        <section className="prose-section" aria-labelledby="enforcement">
          <h2 id="enforcement">What happens when a rule is broken</h2>
          <dl className="prose-dl">
            <dt>Post removal</dt>
            <dd>
              A moderator removes the post. It’s replaced with a note saying it was removed for breaking the rules, so replies keep their
              context. The action is logged.
            </dd>
            <dt>Suspension</dt>
            <dd>
              For serious or repeated breaches, the account is suspended: it’s signed out everywhere, its posts are hidden, and its profile
              shows that it’s suspended. Breaking the rule on minors always means permanent suspension.
            </dd>
          </dl>
          <p>
            Moderators are people, not an algorithm. Every action they take is recorded in a moderation log, and moderators can’t act
            against admins.
          </p>
        </section>

        <section className="prose-section" aria-labelledby="reporting">
          <h2 id="reporting">How to report</h2>
          <p>
            Open the <strong>⋯</strong> menu on any post and choose <em>Report post</em>, or use the menu on someone’s profile to report
            the account. Pick the reason that fits best and add any context that helps. Reports are private: the person you report is
            never told who reported them. Reporting the same thing twice doesn’t speed it up, but reporting different posts does help us
            see a pattern.
          </p>
        </section>

        <section className="prose-section" aria-labelledby="tools">
          <h2 id="tools">Blocks and mutes</h2>
          <dl className="prose-dl">
            <dt>Mute</dt>
            <dd>
              Quietly removes someone from your feeds, Explore, search and notifications. They aren’t told, can still follow you and can
              still see your posts. You can still open their profile and see them in threads.
            </dd>
            <dt>Block</dt>
            <dd>
              A wall in both directions. Neither of you can see the other’s posts, follow, reply, mention-notify or message. Any follows
              between you are removed. They aren’t notified, though they may notice they can’t see you.
            </dd>
            <dt>Muted words</dt>
            <dd>
              Hide posts containing words or phrases you’d rather not see, from your feeds, Explore and search. Manage them in{' '}
              <Link to="/settings/muting">Settings → Muting</Link>.
            </dd>
          </dl>
        </section>

        <footer className="prose-foot meta">
          These rules may be updated as Relay grows; meaningful changes will be announced, not slipped in. See also{' '}
          <Link to="/about">About Relay</Link>.
        </footer>
      </article>
    </>
  );
}
