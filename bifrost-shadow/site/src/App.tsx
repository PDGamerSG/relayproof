import { Closing } from "./components/Closing";
import { Evidence } from "./components/Evidence";
import { Guards } from "./components/Guards";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { Nav } from "./components/Nav";
import { Problem } from "./components/Problem";
import { QuickStart } from "./components/QuickStart";
import { Savings } from "./components/Savings";
import { Scorecard } from "./components/Scorecard";
import { ScrollProvider } from "./lib/scroll";

export function App() {
  return (
    <ScrollProvider>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <HowItWorks />
        <Problem />
        <Savings />
        <Scorecard />
        <Evidence />
        <Guards />
        <QuickStart />
      </main>
      <Closing />
    </ScrollProvider>
  );
}
