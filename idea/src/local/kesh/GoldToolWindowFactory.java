package local.kesh;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jetbrains.annotations.NotNull;
import javax.swing.*;
import java.awt.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.prefs.Preferences;
import java.util.concurrent.CompletableFuture;

public class GoldToolWindowFactory implements ToolWindowFactory {
  public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
    Panel panel = new Panel();
    Content content = toolWindow.getContentManager().getFactory().createContent(panel, "", false);
    content.setDisposer(panel);
    toolWindow.getContentManager().addContent(content);
  }
  static class Panel extends JPanel implements Disposable {
    long lastManualStartNanos = Long.MIN_VALUE;
    boolean acquireManualSlot() {
      long now = System.nanoTime();
      if (lastManualStartNanos != Long.MIN_VALUE && now - lastManualStartNanos < 1_000_000_000L) return false;
      lastManualStartNanos = now;
      return true;
    }
    final Preferences prefs = Preferences.userRoot().node("local/kesh/gold");
    static CompletableFuture<HttpResponse<String>> sendDirect(HttpRequest req){
      return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).proxy(ProxySelector.of(null)).build()
        .sendAsync(req,HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }
    final JLabel buy=new JLabel("--"), change=new JLabel("--"), sell=new JLabel("--"), percent=new JLabel("--"), time=new JLabel("--"), status=new JLabel("等待报价"), error=new JLabel(" ");
    final JLabel usd=new JLabel("约 -- 美元/盎司（1盎司=31.10克）"), exchange=new JLabel("参考汇率：1美元 = -- 人民币"), fxMessage=new JLabel(" "), elapsedLabel=new JLabel("已运行0天00时00分00秒");
    double rate=0; String rateDate=""; long lastFxManual=Long.MIN_VALUE; boolean fxBusy=false;
    final long started = System.currentTimeMillis();
    final Timer seconds;
    Timer noticeTimer, fxNoticeTimer;
    String persistentError="";
    long requestId=0, appliedId=0; String quoteTime="";
    long next=0; String state="等待报价"; volatile boolean disposed=false;
    Panel() {
      setLayout(new GridBagLayout());
      JPanel card=new JPanel(new GridBagLayout());
      card.setBorder(BorderFactory.createEmptyBorder(8,10,8,10));
      GridBagConstraints c=new GridBagConstraints();
      c.anchor=GridBagConstraints.WEST; c.fill=GridBagConstraints.HORIZONTAL; c.weightx=1; c.gridx=0; c.gridy=0;
      JPanel header=new JPanel(new BorderLayout(8,0));
      JPanel price=new JPanel(new FlowLayout(FlowLayout.LEFT,0,0));
      buy.setFont(buy.getFont().deriveFont(Font.PLAIN,27f)); price.add(buy); price.add(Box.createHorizontalStrut(8)); price.add(change);
      header.add(price,BorderLayout.WEST);
      JPanel buttons=new JPanel(new FlowLayout(FlowLayout.RIGHT,4,0));
      JButton refresh=new JButton("刷新"), settings=new JButton("设置"); buttons.add(refresh); buttons.add(settings); header.add(buttons,BorderLayout.EAST);
      error.setText(" "); card.add(error,c);
      c.gridy++; c.insets=new Insets(3,0,0,0); card.add(header,c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(new JLabel("实时买入价（元/克）"),c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(usd,c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(exchange,c);
      JPanel fxRow=new JPanel(new FlowLayout(FlowLayout.LEFT,0,0)); JButton fxRefresh=new JButton("刷新汇率"); fxRow.add(fxRefresh); fxRow.add(Box.createHorizontalStrut(6)); fxRow.add(fxMessage);
      c.gridy++; card.add(fxRow,c); fxRefresh.addActionListener(e->fetchFx(true));
      JPanel values=new JPanel(new GridLayout(1,2,16,0));
      JPanel left=new JPanel(new GridLayout(2,1)); left.add(new JLabel("今日涨跌幅")); left.add(percent);
      JPanel right=new JPanel(new GridLayout(2,1)); right.add(new JLabel("实时卖出价（元/克）")); right.add(sell);
      values.add(left); values.add(right); c.gridy++; c.insets=new Insets(9,0,0,0); card.add(values,c);
      c.gridy++; c.insets=new Insets(7,0,0,0); card.add(time,c);
      c.gridy++; c.insets=new Insets(3,0,0,0); card.add(status,c);
      c.gridy++; c.insets=new Insets(2,0,0,0); card.add(elapsedLabel,c);
      GridBagConstraints outer=new GridBagConstraints(); outer.gridx=0; outer.gridy=0; outer.weightx=1; outer.weighty=1; outer.anchor=GridBagConstraints.SOUTHEAST; outer.insets=new Insets(0,0,10,10); add(card,outer);
      refresh.addActionListener(e->fetch(true)); settings.addActionListener(e->settings());
      seconds=new Timer(1000,e->{long elapsed=(System.currentTimeMillis()-started)/1000; status.setText(state); elapsedLabel.setText("已运行"+format(elapsed));if(System.currentTimeMillis()>=next)fetch();});seconds.start(); fetch(); fetchFx(false);
    }
    int interval(){return Math.max(5,prefs.getInt("seconds",5));}
    void settings(){String input=JOptionPane.showInputDialog(this,"刷新间隔（秒，最小为 5）",Integer.toString(interval()));if(input==null)return;try{int n=Integer.parseInt(input.trim());if(n<5)throw new IllegalArgumentException();prefs.putInt("seconds",n);fetch();}catch(Exception ex){JOptionPane.showMessageDialog(this,"请输入不小于 5 的整数秒。");}}
    void showMessage(String text, boolean temporary, boolean success){if(noticeTimer!=null)noticeTimer.stop();persistentError="";error.setForeground(success?new Color(38,168,62):new Color(220,65,75));error.setText(text.isEmpty()?" ":text);if(!text.isEmpty()){noticeTimer=new Timer(2000,e->error.setText(" "));noticeTimer.setRepeats(false);noticeTimer.start();}}
    void showFxMessage(String text, boolean temporary){if(fxNoticeTimer!=null)fxNoticeTimer.stop();fxMessage.setForeground(text.equals("汇率刷新成功")?new Color(38,168,62):new Color(220,65,75));fxMessage.setText(text.isEmpty()?" ":text);if(temporary&&!text.isEmpty()){fxNoticeTimer=new Timer(2000,e->fxMessage.setText(" "));fxNoticeTimer.setRepeats(false);fxNoticeTimer.start();}}
    void fetch(){fetch(false);}
    void fetch(boolean manual){if(disposed)return;if(manual&&!acquireManualSlot()){showMessage("刷新过快，请间隔至少 1 秒",true,false);return;}final long id=++requestId;if(!manual)next=System.currentTimeMillis()+interval()*1000L;try{String url="https://mbmodule-openapi.paas.cmbchina.com/product/v1/func/market-center", params="[{\"prdType\":\"H\",\"prdCode\":\"\"}]";String body="params="+URLEncoder.encode(params,StandardCharsets.UTF_8);HttpRequest req=HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(15)).header("Content-Type","application/x-www-form-urlencoded").header("Accept","application/json, text/plain, */*").header("Origin","https://mbmodulecdn.cmbimg.com").header("Referer","https://mbmodulecdn.cmbimg.com/").header("X-Requested-With","cmb.pb").header("User-Agent","Mozilla/5.0").POST(HttpRequest.BodyPublishers.ofString(body)).build();sendDirect(req).whenComplete((response,ex)->SwingUtilities.invokeLater(()->{try{if(disposed)return;if(ex!=null)throw new RuntimeException(ex.getMessage());if(response.statusCode()!=200)throw new RuntimeException("HTTP "+response.statusCode());JsonObject result=JsonParser.parseString(response.body()).getAsJsonObject();if(!result.get("success").getAsBoolean())throw new RuntimeException(result.has("msg")?result.get("msg").getAsString():"接口失败");JsonObject data=result.getAsJsonObject("data"),q=data.getAsJsonObject("FQAMBPRCZ1");if(q==null)throw new IllegalStateException("未找到报价字段");String candidate=val(data,"NowTime");if(!candidate.matches("\\d{4}[-/]\\d{2}[-/]\\d{2} \\d{2}:\\d{2}:\\d{2}"))candidate="";candidate=candidate.replace('-','/');boolean useQuote=!candidate.isEmpty()&&!quoteTime.isEmpty()?candidate.compareTo(quoteTime)>0:id>=appliedId;if(!useQuote){if(manual)showMessage("刷新成功",true,true);else if(!persistentError.isEmpty())showMessage("",false,false);return;}appliedId=Math.max(appliedId,id);if(!candidate.isEmpty())quoteTime=candidate;buy.setText(val(q,"zBuyPrc"));updateUsd();sell.setText(val(q,"zSelPrc"));colored(change,val(q,"zDvlCur"),"");colored(percent,val(q,"zPrcDif"),"%");time.setText("报价时间："+val(data,"NowTime"));state=(data.get("MarketDay").getAsBoolean()?"交易日":"非交易日")+" · "+(data.get("QuotedPrice").getAsBoolean()?"报价有效":"报价无效")+" · "+interval()+"秒刷新";if(manual)showMessage("刷新成功",true,true);else if(!persistentError.isEmpty())showMessage("",false,false);}catch(Exception e){if(id>=appliedId){appliedId=id;showMessage("刷新失败："+e.getMessage(),false,false);}else if(manual)showMessage("本次刷新失败",true,false);}}));}catch(Exception e){if(id>=appliedId){appliedId=id;showMessage("刷新失败："+e.getMessage(),false,false);}else if(manual)showMessage("本次刷新失败",true,false);}}
    static String val(JsonObject o,String k){return o!=null&&o.has(k)&&!o.get(k).isJsonNull()?o.get(k).getAsString():"--";}
    static void colored(JLabel l,String s,String suffix){try{double n=Double.parseDouble(s);l.setText((n>0&&!s.startsWith("+")?"+":"")+s+suffix);l.setForeground(n>0?new Color(220,65,75):n<0?new Color(38,168,62):UIManager.getColor("Label.foreground"));}catch(Exception e){l.setText("--");}}
    void updateUsd(){exchange.setText(rate>0?String.format(Locale.ROOT,"参考汇率：1美元 = %.2f 人民币（中行现汇买卖均价）",rate):"参考汇率：1美元 = -- 人民币"); exchange.setToolTipText(rateDate.isEmpty()?null:"中行牌价时间："+rateDate);try{double price=Double.parseDouble(buy.getText()); if(!(rate>0)||!(price>0)||!Double.isFinite(price))throw new IllegalStateException();usd.setText(String.format(Locale.ROOT,"约 %.2f 美元/盎司（1盎司=31.10克）",price*31.1034768/rate));}catch(Exception e){usd.setText("约 -- 美元/盎司（1盎司=31.10克）");}}
    static String[] parseFx(String html){
      Matcher row=Pattern.compile("<tr\\b[^>]*>\\s*<td[^>]*>\\s*美元\\s*</td>([\\s\\S]*?)</tr>",Pattern.CASE_INSENSITIVE).matcher(html);
      if(!row.find())throw new IllegalArgumentException("未找到美元牌价");
      Matcher cells=Pattern.compile("<td\\b[^>]*>([\\s\\S]*?)</td>",Pattern.CASE_INSENSITIVE).matcher(row.group(1));
      java.util.List<String> values=new java.util.ArrayList<>();while(cells.find())values.add(cells.group(1).replaceAll("<[^>]*>","").trim());
      if(values.size()<6)throw new IllegalArgumentException("美元牌价格式无效");
      double bid=Double.parseDouble(values.get(0)),ask=Double.parseDouble(values.get(2));
      if(!(bid>0)||!(ask>=bid)||!Double.isFinite(ask))throw new IllegalArgumentException("美元牌价格式无效");
      return new String[]{Double.toString((bid+ask)/200),values.get(5)};
    }
    void fetchFx(boolean manual){
      if(disposed)return;
      long now=System.nanoTime();
      if(manual&&lastFxManual!=Long.MIN_VALUE&&now-lastFxManual<10_000_000_000L){showFxMessage("汇率刷新过快，请间隔至少 10 秒",true);return;}
      if(fxBusy){if(manual)showFxMessage("汇率刷新失败，请稍后再试",true);return;}
      if(manual)lastFxManual=now;
      fxBusy=true;if(manual)showFxMessage("",false);
      try{
        HttpRequest r=HttpRequest.newBuilder(URI.create("https://www.bankofchina.com/sourcedb/whpj/")).timeout(Duration.ofSeconds(15)).header("User-Agent","Mozilla/5.0").GET().build();
        sendDirect(r).whenComplete((response,ex)->SwingUtilities.invokeLater(()->{
          try{if(disposed)return;if(ex!=null)throw new IllegalStateException(ex.getMessage());if(response.statusCode()!=200)throw new IllegalStateException("HTTP "+response.statusCode());String[] fx=parseFx(response.body());rate=Double.parseDouble(fx[0]);rateDate=fx[1];fxMessage.setToolTipText(null);showFxMessage(manual?"汇率刷新成功":"",true);}
          catch(Exception e){rate=0;rateDate="";fxMessage.setToolTipText(e.getMessage());showFxMessage("汇率刷新失败，请检查网络",true);}
          finally{if(!disposed){updateUsd();fxBusy=false;}}
        }));
      }catch(Exception e){rate=0;rateDate="";updateUsd();fxBusy=false;fxMessage.setToolTipText(e.getMessage());showFxMessage("汇率刷新失败，请检查网络",true);}
    }
    static String format(long s){return String.format(Locale.ROOT,"%d天%02d时%02d分%02d秒",s/86400,(s/3600)%24,(s/60)%60,s%60);}
    public void dispose(){disposed=true;seconds.stop();if(noticeTimer!=null)noticeTimer.stop();if(fxNoticeTimer!=null)fxNoticeTimer.stop();}
  }
}
