import ecosystem from '../diagrams/ecosystem.svg?raw';
import master from '../diagrams/master.svg?raw';
import state from '../diagrams/state.svg?raw';
import recorder from '../diagrams/recorder.svg?raw';
import chain from '../diagrams/chain.svg?raw';
import ingest from '../diagrams/ingest.svg?raw';
import readpath from '../diagrams/readpath.svg?raw';
import er from '../diagrams/er.svg?raw';
import analysis from '../diagrams/analysis.svg?raw';
import staff from '../diagrams/staff.svg?raw';
import provgate from '../diagrams/provgate.svg?raw';
import deploy from '../diagrams/deploy.svg?raw';
import roadmap from '../diagrams/roadmap.svg?raw';

export type ArchSection = {
  id: string;
  num: string;
  title: string;
  framing: string;
  diagram: string;
  svg: string;
};

export const SECTIONS: ArchSection[] = [
  {
    id: 'ecosystem',
    num: '01',
    title: 'Repository & contract graph',
    diagram: 'ecosystem',
    svg: ecosystem,
    framing:
      'Four repositories. One owns the log format; the other three consume or reimplement it and are forbidden from changing it unilaterally. Conformance vectors are the enforcement mechanism — a sibling implementation must reproduce log-core’s test vectors byte for byte.',
  },
  {
    id: 'master',
    num: '02',
    title: 'End-to-end map',
    diagram: 'master',
    svg: master,
    framing:
      'The whole system as five swimlanes: the student’s offline machine, transport, the server, the analysis engine, and the staff reviewing the result. Every branch that exists in the code is drawn — including the paths where nothing is recorded, nothing is ingested, and nothing is done.',
  },
  {
    id: 'state',
    num: '03',
    title: 'Recorder state machine',
    diagram: 'state',
    svg: state,
    framing:
      'Three abnormal states had to be modelled explicitly, because each is otherwise indistinguishable from evasion.',
  },
  {
    id: 'recorder',
    num: '04',
    title: 'Recorder dataflow',
    diagram: 'recorder',
    svg: recorder,
    framing:
      'Host events in, hash-chained entries out. The top band is the only layer that differs between VS Code, IntelliJ and Neovim; everything below is shared logic reimplemented in three languages against the same vectors.',
  },
  {
    id: 'chain',
    num: '05',
    title: 'Format contract & cryptography',
    diagram: 'chain',
    svg: chain,
    framing:
      'Three keys with three distinct jobs, a chain linking every entry to its predecessor, and a verification path that still works years later against a bundle whose source files have been deleted.',
  },
  {
    id: 'ingest',
    num: '06',
    title: 'Ingest pipeline',
    diagram: 'ingest',
    svg: ingest,
    framing:
      'Four ordered stages with every rejection and failure path drawn. The pipeline is idempotent: a retry must produce byte-identical flags and stats, and tests assert it.',
  },
  {
    id: 'readpath',
    num: '07',
    title: 'Read path',
    diagram: 'readpath',
    svg: readpath,
    framing:
      'Cheap requests are answered from precomputed Postgres rows; anything needing the event stream re-parses the stored bundle, because there is no events table.',
  },
  {
    id: 'er',
    num: '08',
    title: 'Data model',
    diagram: 'er',
    svg: er,
    framing:
      'Twenty-one tables via Drizzle. The defining property is what is absent: no events table, and no student source in the stored blobs.',
  },
  {
    id: 'analysis',
    num: '09',
    title: 'Analysis engine',
    diagram: 'analysis',
    svg: analysis,
    framing:
      'A bundle goes in; a deterministic ranked flag list comes out. The same graph executes on the server during ingest and in the browser on the /local route.',
  },
  {
    id: 'staff',
    num: '10',
    title: 'Course-staff journey',
    diagram: 'staff',
    svg: staff,
    framing:
      'Staff work a ranked queue, not raw logs. The premise is 700 submissions and one afternoon, so the system’s job is to put the twelve that deserve a human at the top and justify each one.',
  },
  {
    id: 'provgate',
    num: '11',
    title: 'provgate — the Gradescope gateway',
    diagram: 'provgate',
    svg: provgate,
    framing:
      'A standalone Python service that keeps Provenance in sync with Gradescope on a schedule. It holds no Provenance code, database or storage — it authenticates like any third-party client.',
  },
  {
    id: 'deploy',
    num: '12',
    title: 'Deployment',
    diagram: 'deploy',
    svg: deploy,
    framing:
      'Running on the EECS Instructional apphost. There is no CI/CD — GitHub’s hosted runners cannot reach the host, so every step is run by hand against a documented runbook.',
  },
  {
    id: 'roadmap',
    num: '13',
    title: 'Roadmap',
    diagram: 'roadmap',
    svg: roadmap,
    framing:
      'Everything above is shipped and live. Below is not built — each item is drawn attached to the existing seam it would extend.',
  },
];
