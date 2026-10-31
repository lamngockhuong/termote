import { Composition, Still } from "remotion";
import { HERO_FRAMES, Hero } from "./hero";
import { Poster } from "./poster";
import {
  DESKTOP_SIZE,
  PHONES_SIZE,
  STYLES_SIZE,
  ReadmeDesktop,
  ReadmePhones,
  ReadmeStyles,
} from "./readme-shots";
import { BrandScene } from "./scenes/brand";
import { ChangesScene } from "./scenes/changes";
import { ChatScene } from "./scenes/chat";
import { FilesScene } from "./scenes/files";
import { HookScene } from "./scenes/hook";
import { InstallScene } from "./scenes/install";
import { NotifyScene } from "./scenes/notify";
import { OutroScene } from "./scenes/outro";
import { PanesScene } from "./scenes/panes";
import { SecurityScene } from "./scenes/security";
import { SessionsScene } from "./scenes/sessions";
import { TasksScene } from "./scenes/tasks";
import { TerminalScene } from "./scenes/terminal";
import { Music } from "./components/sfx";
import { lengthOf, type Part, Sequence } from "./sequence";
import { FPS } from "./theme";

// README and website: every feature, about a minute and a quarter
const intro: Part[] = [
  { id: "hook", frames: 150, scene: HookScene },
  { id: "brand", frames: 110, scene: BrandScene },
  { id: "install", frames: 240, scene: InstallScene },
  { id: "terminal", frames: 230, scene: TerminalScene },
  { id: "chat", frames: 320, scene: ChatScene },
  { id: "changes", frames: 230, scene: ChangesScene },
  { id: "files", frames: 150, scene: FilesScene },
  { id: "sessions", frames: 170, scene: SessionsScene },
  { id: "panes", frames: 165, scene: PanesScene },
  { id: "tasks", frames: 150, scene: TasksScene },
  { id: "notify", frames: 190, scene: NotifyScene },
  { id: "security", frames: 150, scene: SecurityScene },
  { id: "outro", frames: 165, scene: OutroScene },
];

// Social: phone-first, the strongest moments, about 30 s
const vertical: Part[] = [
  { id: "hook", frames: 120, scene: HookScene },
  { id: "brand", frames: 90, scene: BrandScene },
  { id: "chat", frames: 270, scene: ChatScene },
  { id: "changes", frames: 190, scene: ChangesScene },
  { id: "notify", frames: 200, scene: NotifyScene },
  { id: "outro", frames: 150, scene: OutroScene },
];

const IntroVideo: React.FC = () => (
  <>
    <Music />
    <Sequence parts={intro} />
  </>
);
const VerticalVideo: React.FC = () => (
  <>
    <Music />
    <Sequence parts={vertical} />
  </>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="TermoteIntro"
      component={IntroVideo}
      durationInFrames={lengthOf(intro)}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="TermoteHero"
      component={Hero}
      durationInFrames={HERO_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="TermoteIntroVertical"
      component={VerticalVideo}
      durationInFrames={lengthOf(vertical)}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Still id="TermotePoster" component={Poster} width={1920} height={1080} />
    <Still id="ReadmePhones" component={ReadmePhones} {...PHONES_SIZE} />
    <Still id="ReadmeDesktop" component={ReadmeDesktop} {...DESKTOP_SIZE} />
    <Still id="ReadmeStyles" component={ReadmeStyles} {...STYLES_SIZE} />
  </>
);
