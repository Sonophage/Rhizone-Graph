import { FuzzySuggestModal, type App, type TFile } from "obsidian";

/** A fuzzy note picker for reconnect/repoint remediation. */
export class NotePickerModal extends FuzzySuggestModal<TFile> {
  private onChoose: (f: TFile) => void;

  constructor(app: App, onChoose: (f: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Pick a note to connect to…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(f: TFile): string {
    return f.basename;
  }

  onChooseItem(f: TFile): void {
    this.onChoose(f);
  }
}
