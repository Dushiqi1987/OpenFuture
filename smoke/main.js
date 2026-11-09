const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  console.log('SMOKE_READY', process.versions.electron, process.versions.chrome)
  const win = new BrowserWindow({ width: 400, height: 300, show: false })
  win.loadURL('data:text/html,<h1>ok</h1>')
  win.webContents.on('did-finish-load', () => {
    console.log('SMOKE_LOADED')
    setTimeout(() => app.quit(), 1000)
  })
})
